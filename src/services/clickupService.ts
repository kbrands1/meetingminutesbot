import axios, { AxiosInstance, AxiosError } from 'axios';
import { getClickUpApiKey, appConfig } from '../config/index.js';
import type {
  ClickUpTask,
  ClickUpCreateTaskPayload,
  ClickUpMember,
  TaskPriority,
  ExtractionType
} from '../types/index.js';

const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';

// ClickUp priority mapping (1=urgent, 2=high, 3=normal, 4=low)
const PRIORITY_MAP: Record<TaskPriority, number> = {
  urgent: 1,
  high: 2,
  normal: 3,
  low: 4
};

// Cache for workspace members (refreshed every 5 minutes)
let membersCache: ClickUpMember[] | null = null;
let membersCacheTime: number = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Create an axios instance for ClickUp API.
 */
function getClickUpClient(): AxiosInstance {
  return axios.create({
    baseURL: CLICKUP_API_BASE,
    headers: {
      'Authorization': getClickUpApiKey(),
      'Content-Type': 'application/json'
    }
  });
}

/**
 * Retry configuration for rate limit handling.
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      if (error instanceof AxiosError && error.response?.status === 429) {
        // Rate limited - wait and retry
        const retryAfter = parseInt(error.response.headers['retry-after'] || '5', 10);
        const waitTime = retryAfter * 1000 * Math.pow(2, attempt);
        console.log(`Rate limited. Waiting ${waitTime}ms before retry ${attempt + 1}/${maxRetries}`);
        await sleep(waitTime);
      } else {
        // Not a rate limit error, throw immediately
        throw error;
      }
    }
  }

  throw lastError;
}

/**
 * Get workspace members for dropdown population.
 * Results are cached for 5 minutes to reduce API calls.
 */
export async function getWorkspaceMembers(forceRefresh: boolean = false): Promise<ClickUpMember[]> {
  // Return cached members if still valid
  if (!forceRefresh && membersCache && Date.now() - membersCacheTime < CACHE_TTL_MS) {
    return membersCache;
  }

  const client = getClickUpClient();
  const workspaceId = appConfig.clickup.workspaceId;

  const response = await withRetry(async () => {
    return client.get(`/team/${workspaceId}`);
  });

  const members = response.data.team?.members || [];
  membersCache = members.map((m: any) => ({
    id: m.user.id,
    username: m.user.username,
    email: m.user.email,
    color: m.user.color,
    profilePicture: m.user.profilePicture
  }));
  membersCacheTime = Date.now();

  console.log(`Loaded ${membersCache!.length} members from ClickUp workspace`);
  return membersCache!;
}

/**
 * Find the best matching ClickUp member for a name from the transcript.
 * Matches against username, email, and common name patterns.
 */
export async function findMemberByName(name: string): Promise<ClickUpMember | null> {
  const members = await getWorkspaceMembers();
  const normalizedName = name.toLowerCase().trim();

  // Try exact matches first
  let match = members.find(m =>
    m.username.toLowerCase() === normalizedName ||
    m.email.toLowerCase() === normalizedName ||
    m.email.split('@')[0].toLowerCase() === normalizedName
  );

  if (match) return match;

  // Try partial matches (first name, last name)
  match = members.find(m => {
    const username = m.username.toLowerCase();
    const emailName = m.email.split('@')[0].toLowerCase().replace(/[._-]/g, ' ');

    return (
      username.includes(normalizedName) ||
      normalizedName.includes(username.split(' ')[0]) ||
      emailName.includes(normalizedName) ||
      normalizedName.includes(emailName.split(' ')[0])
    );
  });

  return match || null;
}

/**
 * Get list details including custom fields.
 */
export async function getListDetails(listId: string): Promise<{
  id: string;
  name: string;
  customFields: Array<{ id: string; name: string; type: string }>;
}> {
  const client = getClickUpClient();

  const response = await withRetry(async () => {
    return client.get(`/list/${listId}`);
  });

  return {
    id: response.data.id,
    name: response.data.name,
    customFields: response.data.folder?.custom_fields || []
  };
}

/**
 * Create a task in ClickUp.
 */
export async function createTask(
  listId: string,
  taskData: {
    name: string;
    description?: string;
    assigneeId?: number;
    dueDate?: string;
    priority?: TaskPriority;
    meetingLink?: string;
    extractionType?: ExtractionType;
    sourceFolder?: string;
  }
): Promise<ClickUpTask> {
  const client = getClickUpClient();

  const payload: ClickUpCreateTaskPayload = {
    name: taskData.name,
    description: taskData.description
  };

  // Add assignee if provided
  if (taskData.assigneeId) {
    payload.assignees = [taskData.assigneeId];
  }

  // Add due date if provided (convert ISO string to Unix timestamp in ms)
  if (taskData.dueDate) {
    const dueTimestamp = new Date(taskData.dueDate).getTime();
    payload.due_date = dueTimestamp;
  }

  // Add priority if provided
  if (taskData.priority) {
    payload.priority = PRIORITY_MAP[taskData.priority];
  }

  // Note: Custom fields need to be added after we know the list's custom field IDs
  // For now, we'll include this info in the description

  const response = await withRetry(async () => {
    return client.post(`/list/${listId}/task`, payload);
  });

  const task = response.data;

  // If we have custom fields to set, update the task
  if (taskData.meetingLink || taskData.extractionType || taskData.sourceFolder) {
    await updateTaskCustomFields(task.id, listId, {
      meetingLink: taskData.meetingLink,
      extractionType: taskData.extractionType,
      sourceFolder: taskData.sourceFolder
    });
  }

  return {
    id: task.id,
    name: task.name,
    description: task.description,
    status: task.status?.status || 'Open',
    priority: task.priority,
    assignees: task.assignees,
    due_date: task.due_date,
    url: task.url
  };
}

/**
 * Update task custom fields.
 */
async function updateTaskCustomFields(
  taskId: string,
  listId: string,
  customData: {
    meetingLink?: string;
    extractionType?: ExtractionType;
    sourceFolder?: string;
  }
): Promise<void> {
  const client = getClickUpClient();

  try {
    // Get list custom fields
    const listDetails = await getListDetails(listId);
    const customFields = listDetails.customFields;

    for (const field of customFields) {
      let value: string | undefined;

      if (field.name.toLowerCase().includes('meeting') && customData.meetingLink) {
        value = customData.meetingLink;
      } else if (field.name.toLowerCase().includes('extraction') && customData.extractionType) {
        value = customData.extractionType;
      } else if (field.name.toLowerCase().includes('folder') && customData.sourceFolder) {
        value = customData.sourceFolder;
      }

      if (value) {
        await withRetry(async () => {
          return client.post(`/task/${taskId}/field/${field.id}`, { value });
        });
      }
    }
  } catch (error) {
    // Custom field updates are optional, log but don't fail
    console.warn('Failed to update custom fields:', error);
  }
}

/**
 * Get task by ID.
 */
export async function getTask(taskId: string): Promise<ClickUpTask | null> {
  const client = getClickUpClient();

  try {
    const response = await withRetry(async () => {
      return client.get(`/task/${taskId}`);
    });

    const task = response.data;
    return {
      id: task.id,
      name: task.name,
      description: task.description,
      status: task.status?.status || 'Open',
      priority: task.priority,
      assignees: task.assignees,
      due_date: task.due_date,
      url: task.url
    };
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Create multiple tasks in bulk.
 */
export async function createTasksBulk(
  listId: string,
  tasks: Array<{
    name: string;
    description?: string;
    assigneeId?: number;
    dueDate?: string;
    priority?: TaskPriority;
  }>
): Promise<ClickUpTask[]> {
  const createdTasks: ClickUpTask[] = [];

  for (const taskData of tasks) {
    try {
      const task = await createTask(listId, taskData);
      createdTasks.push(task);

      // Small delay between creations to avoid rate limits
      await sleep(200);
    } catch (error) {
      console.error(`Failed to create task "${taskData.name}":`, error);
      // Continue with other tasks even if one fails
    }
  }

  return createdTasks;
}

/**
 * Find a member by email or name.
 */
export async function findMember(
  identifier: string
): Promise<ClickUpMember | null> {
  const members = await getWorkspaceMembers();
  const normalizedId = identifier.toLowerCase();

  return members.find(m =>
    m.email.toLowerCase() === normalizedId ||
    m.username.toLowerCase() === normalizedId ||
    m.username.toLowerCase().includes(normalizedId)
  ) || null;
}

/**
 * Validate that a list exists and is accessible.
 */
export async function validateList(listId: string): Promise<boolean> {
  try {
    await getListDetails(listId);
    return true;
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 404) {
      return false;
    }
    throw error;
  }
}

/**
 * Simple sleep utility.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
