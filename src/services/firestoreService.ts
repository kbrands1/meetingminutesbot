import { Firestore, FieldValue } from '@google-cloud/firestore';
import { v4 as uuidv4 } from 'uuid';
import { getConfig } from '../config/index.js';
import type {
  PendingTasksData,
  FolderConfig,
  ExtractedTaskWithConfig,
  MeetingInfo,
  MeetingAnalysis
} from '../types/index.js';

const config = getConfig();
const firestore = new Firestore();

/**
 * Get the pending tasks collection reference.
 */
function getPendingTasksCollection() {
  return firestore.collection(config.gcp.firestoreCollection);
}

/**
 * Store pending tasks for later retrieval during chat interaction.
 */
export async function storePendingTasks(data: {
  fileId: string;
  folderId: string;
  folderConfig: FolderConfig;
  tasks: ExtractedTaskWithConfig[];
  meetingInfo: MeetingInfo;
  analysis: MeetingAnalysis;
}): Promise<string> {
  const pendingId = uuidv4();

  const pendingData: PendingTasksData = {
    ...data,
    createdAt: new Date(),
    status: 'pending'
  };

  await getPendingTasksCollection().doc(pendingId).set({
    ...pendingData,
    createdAt: FieldValue.serverTimestamp()
  });

  console.log(`Stored pending tasks with ID: ${pendingId}`);
  return pendingId;
}

/**
 * Retrieve pending tasks by ID.
 */
export async function getPendingTasks(pendingId: string): Promise<PendingTasksData | null> {
  const doc = await getPendingTasksCollection().doc(pendingId).get();

  if (!doc.exists) {
    console.warn(`Pending tasks not found: ${pendingId}`);
    return null;
  }

  const data = doc.data() as PendingTasksData;
  return data;
}

/**
 * Update the status of pending tasks.
 */
export async function updatePendingTasksStatus(
  pendingId: string,
  status: PendingTasksData['status']
): Promise<void> {
  await getPendingTasksCollection().doc(pendingId).update({
    status,
    updatedAt: FieldValue.serverTimestamp()
  });
}

/**
 * Mark a specific task as created in ClickUp.
 * Automatically marks the parent document as 'completed' if all tasks are resolved.
 */
export async function markTaskAsCreated(
  pendingId: string,
  taskIndex: number,
  clickupTaskId: string
): Promise<void> {
  const docRef = getPendingTasksCollection().doc(pendingId);

  await firestore.runTransaction(async (transaction) => {
    const doc = await transaction.get(docRef);

    if (!doc.exists) {
      throw new Error(`Pending tasks not found: ${pendingId}`);
    }

    const data = doc.data() as PendingTasksData;
    const tasks = [...data.tasks];

    if (taskIndex < 0 || taskIndex >= tasks.length) {
      throw new Error(`Invalid task index: ${taskIndex}`);
    }

    // Add clickup task ID to the task
    (tasks[taskIndex] as any).clickupTaskId = clickupTaskId;
    (tasks[taskIndex] as any).createdAt = new Date().toISOString();

    const updates: Record<string, any> = {
      tasks,
      updatedAt: FieldValue.serverTimestamp()
    };

    // If all tasks are now dismissed or created, mark the whole set as completed
    if (areAllTasksResolved(tasks)) {
      updates.status = 'completed';
    }

    transaction.update(docRef, updates);
  });
}

/**
 * Mark a task as dismissed (user declined to create it).
 * Automatically marks the parent document as 'completed' if all tasks are resolved.
 */
export async function markTaskAsDismissed(
  pendingId: string,
  taskIndex: number
): Promise<void> {
  const docRef = getPendingTasksCollection().doc(pendingId);

  await firestore.runTransaction(async (transaction) => {
    const doc = await transaction.get(docRef);

    if (!doc.exists) {
      throw new Error(`Pending tasks not found: ${pendingId}`);
    }

    const data = doc.data() as PendingTasksData;
    const tasks = [...data.tasks];

    if (taskIndex < 0 || taskIndex >= tasks.length) {
      throw new Error(`Invalid task index: ${taskIndex}`);
    }

    (tasks[taskIndex] as any).dismissed = true;
    (tasks[taskIndex] as any).dismissedAt = new Date().toISOString();

    const updates: Record<string, any> = {
      tasks,
      updatedAt: FieldValue.serverTimestamp()
    };

    // If all tasks are now dismissed or created, mark the whole set as completed
    if (areAllTasksResolved(tasks)) {
      updates.status = 'completed';
    }

    transaction.update(docRef, updates);
  });
}

/**
 * Update task details before creation (from user edits in the card).
 */
export async function updateTaskDetails(
  pendingId: string,
  taskIndex: number,
  updates: Partial<ExtractedTaskWithConfig>
): Promise<void> {
  const docRef = getPendingTasksCollection().doc(pendingId);

  await firestore.runTransaction(async (transaction) => {
    const doc = await transaction.get(docRef);

    if (!doc.exists) {
      throw new Error(`Pending tasks not found: ${pendingId}`);
    }

    const data = doc.data() as PendingTasksData;
    const tasks = [...data.tasks];

    if (taskIndex < 0 || taskIndex >= tasks.length) {
      throw new Error(`Invalid task index: ${taskIndex}`);
    }

    tasks[taskIndex] = { ...tasks[taskIndex], ...updates };

    transaction.update(docRef, {
      tasks,
      updatedAt: FieldValue.serverTimestamp()
    });
  });
}

/**
 * Check if all tasks in a set are resolved (either created or dismissed).
 */
function areAllTasksResolved(tasks: any[]): boolean {
  return tasks.every(t => t.clickupTaskId || t.dismissed);
}

/**
 * Get all pending tasks for a specific file (to prevent duplicates).
 */
export async function getPendingTasksByFileId(fileId: string): Promise<PendingTasksData[]> {
  const snapshot = await getPendingTasksCollection()
    .where('fileId', '==', fileId)
    .where('status', '==', 'pending')
    .get();

  return snapshot.docs.map(doc => doc.data() as PendingTasksData);
}

/**
 * Check if a file has already been processed (any status).
 * This prevents duplicate processing even after tasks have been completed/dismissed.
 */
export async function isFileAlreadyProcessed(fileId: string): Promise<boolean> {
  const snapshot = await getPendingTasksCollection()
    .where('fileId', '==', fileId)
    .limit(1)
    .get();

  return !snapshot.empty;
}

/**
 * Clean up old pending tasks (older than specified days).
 */
export async function cleanupOldPendingTasks(olderThanDays: number = 7): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

  const snapshot = await getPendingTasksCollection()
    .where('createdAt', '<', cutoffDate)
    .get();

  const batch = firestore.batch();
  let count = 0;

  for (const doc of snapshot.docs) {
    batch.delete(doc.ref);
    count++;
  }

  if (count > 0) {
    await batch.commit();
    console.log(`Cleaned up ${count} old pending task records`);
  }

  return count;
}

/**
 * Get statistics about pending tasks.
 */
export async function getPendingTasksStats(): Promise<{
  total: number;
  pending: number;
  processing: number;
  completed: number;
}> {
  const snapshot = await getPendingTasksCollection().get();

  const stats = {
    total: snapshot.size,
    pending: 0,
    processing: 0,
    completed: 0
  };

  for (const doc of snapshot.docs) {
    const data = doc.data() as PendingTasksData;
    switch (data.status) {
      case 'pending':
        stats.pending++;
        break;
      case 'processing':
        stats.processing++;
        break;
      case 'completed':
        stats.completed++;
        break;
    }
  }

  return stats;
}

/**
 * Get pending tasks for a user (most recent first).
 * @param limit Max results to return
 * @param allStatuses If true, return all statuses (for recent command); otherwise only 'pending'
 */
export async function getUserPendingTasks(limit: number = 5, allStatuses: boolean = false): Promise<(PendingTasksData & { id: string })[]> {
  let query = getPendingTasksCollection()
    .orderBy('createdAt', 'desc')
    .limit(limit);

  if (!allStatuses) {
    query = getPendingTasksCollection()
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'desc')
      .limit(limit);
  }

  const snapshot = await query.get();

  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data() as PendingTasksData
  }));
}
