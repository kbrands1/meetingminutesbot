import { CloudEvent } from '@google-cloud/functions-framework';
import {
  getFileFolderId,
  getFileContent,
  getFileMetadata,
  isValidTranscript
} from '../services/driveService.js';
import { getFolderConfig, getClickUpListId, getNotifyUsers } from '../utils/folderConfigResolver.js';
import { extractTasks } from '../services/openaiService.js';
import { sendTaskApprovalCards, sendDMToUser } from '../services/chatService.js';
import { storePendingTasks, isFileAlreadyProcessed } from '../services/firestoreService.js';
import { parseTranscript } from '../utils/transcriptParser.js';
import { appConfig } from '../config/index.js';
import type {
  TranscriptPubSubMessage,
  MeetingInfo,
  ExtractedTaskWithConfig
} from '../types/index.js';

/**
 * Cloud Function triggered by Pub/Sub when a new file is added to a monitored Drive folder.
 */
export async function processTranscript(
  event: CloudEvent<{ message?: { data?: string }; data?: string }>
): Promise<void> {
  console.log('Processing transcript event');

  // Parse the Pub/Sub message - handle various Eventarc/Pub/Sub formats
  let messageData: TranscriptPubSubMessage;

  try {
    const eventData = event.data as any;
    console.log('Event data type:', typeof eventData);

    let base64Data: string;
    if (typeof eventData === 'string') {
      // Eventarc delivers data as base64 string directly
      base64Data = eventData;
    } else if (eventData?.message?.data) {
      // Standard Pub/Sub CloudEvent format: { message: { data: "base64..." } }
      base64Data = eventData.message.data;
    } else if (eventData?.data) {
      // Alternative format: { data: "base64..." }
      base64Data = eventData.data;
    } else {
      console.error('Unknown event format:', JSON.stringify(event));
      throw new Error('Unable to parse Pub/Sub message');
    }

    const decodedString = Buffer.from(base64Data, 'base64').toString();
    console.log('Decoded message:', decodedString);
    messageData = JSON.parse(decodedString) as TranscriptPubSubMessage;
  } catch (error) {
    console.error('Error parsing event:', error);
    throw error;
  }

  const { fileId } = messageData;
  console.log(`Processing file: ${fileId}`);

  // Check if already processed to prevent duplicates
  const alreadyProcessed = await isFileAlreadyProcessed(fileId);
  if (alreadyProcessed) {
    console.log(`File ${fileId} has already been processed, skipping`);
    return;
  }

  // Get the folder this file belongs to
  const folderId = messageData.folderId || await getFileFolderId(fileId);

  if (!folderId) {
    console.error(`Could not determine folder for file: ${fileId}`);
    return;
  }

  // Load folder-specific configuration
  const folderConfig = getFolderConfig(folderId);
  console.log(`Processing transcript from folder: ${folderConfig.name}`);

  // Get file metadata first to validate it's a transcript
  const metadata = await getFileMetadata(fileId);

  if (!isValidTranscript(metadata)) {
    console.log(`File ${fileId} (${metadata.name}) is not a valid transcript format, skipping`);
    return;
  }

  // Get file content
  const rawContent = await getFileContent(fileId);

  // Parse the transcript to extract clean text and attendees
  const parsedTranscript = parseTranscript(rawContent);

  const meetingInfo: MeetingInfo = {
    title: metadata.name.replace(/\.(txt|docx|vtt|srt|doc)$/i, ''),
    date: metadata.createdTime,
    attendees: parsedTranscript.attendees,
    folderId: folderId,
    folderName: folderConfig.name
  };

  console.log(`Meeting: ${meetingInfo.title}, Attendees: ${meetingInfo.attendees.length}`);

  // Extract tasks using OpenAI
  console.log('Extracting tasks with OpenAI...');
  const analysis = await extractTasks(parsedTranscript.content, meetingInfo);
  console.log(`Found ${analysis.tasks.length} tasks`);

  if (analysis.tasks.length === 0) {
    console.log('No tasks found in transcript');
    return;
  }

  // Filter tasks by confidence threshold (explicit tasks always pass)
  const confidenceThreshold = appConfig.openai.confidenceThreshold;
  const filteredTasks = analysis.tasks.filter(task =>
    task.extraction_type === 'explicit' || task.confidence >= confidenceThreshold
  );

  console.log(`Filtered ${analysis.tasks.length} tasks to ${filteredTasks.length} (threshold: ${confidenceThreshold})`);

  if (filteredTasks.length === 0) {
    console.log('No tasks above confidence threshold');
    return;
  }

  // Get the single ClickUp list ID for all meeting tasks
  const clickupListId = getClickUpListId();

  // Apply folder-specific task prefix
  const tasksWithConfig: ExtractedTaskWithConfig[] = filteredTasks.map(task => ({
    ...task,
    title: folderConfig.taskPrefix
      ? `${folderConfig.taskPrefix} ${task.title}`
      : task.title,
    clickupListId: clickupListId
  }));

  // Handle confidential folders - redact source quotes
  if (folderConfig.confidential) {
    tasksWithConfig.forEach(task => {
      task.source_quote = '[Confidential - see transcript]';
      task.description = task.title; // Minimal description
    });
  }

  // Store pending tasks for webhook retrieval
  const pendingId = await storePendingTasks({
    fileId,
    folderId,
    folderConfig,
    tasks: tasksWithConfig,
    meetingInfo,
    analysis
  });

  console.log(`Stored pending tasks with ID: ${pendingId}`);

  // Get transcript link for reference
  const transcriptLink = metadata.webViewLink;

  // Get all users to notify (global + folder-specific)
  const notifyUsers = getNotifyUsers(folderId);
  const ownerEmail = metadata.owners?.[0]?.emailAddress;

  // Collect all users to DM (notify users + file owner if dm_owner mode)
  const usersToNotify = new Set<string>(notifyUsers);

  // Send approval cards based on folder notification config
  if (folderConfig.notifyChat.type === 'space' && folderConfig.notifyChat.spaceId) {
    await sendTaskApprovalCards({
      spaceId: folderConfig.notifyChat.spaceId,
      pendingId,
      tasks: tasksWithConfig,
      meetingInfo,
      folderName: folderConfig.name,
      analysis,
      transcriptLink
    });
    console.log(`Sent approval cards to space: ${folderConfig.notifyChat.spaceId}`);
  } else if (ownerEmail) {
    // Add owner to notify list if dm_owner mode
    usersToNotify.add(ownerEmail);
  }

  // Send DMs to all users that should be notified
  for (const userEmail of usersToNotify) {
    try {
      await sendDMToUser({
        userEmail,
        pendingId,
        tasks: tasksWithConfig,
        meetingInfo,
        folderName: folderConfig.name,
        analysis,
        transcriptLink
      });
      console.log(`Sent approval cards via DM to: ${userEmail}`);
    } catch (error) {
      console.error(`Failed to send DM to ${userEmail}:`, error);
    }
  }

  if (usersToNotify.size === 0 && folderConfig.notifyChat.type !== 'space') {
    console.warn(`No users to notify for file ${fileId}`);
  }

  console.log(`Processed ${tasksWithConfig.length} tasks from ${folderConfig.name}, notified ${usersToNotify.size} users`);
}

/**
 * Extract attendees from file metadata (if available in description or properties).
 */
export function extractAttendeesFromMetadata(metadata: any): string[] {
  const attendees: string[] = [];

  // Check file description for attendee list
  if (metadata.description) {
    const attendeeMatch = metadata.description.match(/attendees?:\s*([^\n]+)/i);
    if (attendeeMatch) {
      const names = attendeeMatch[1].split(/[,;]/).map((n: string) => n.trim());
      attendees.push(...names);
    }
  }

  // Add file owner as attendee
  if (metadata.owners?.[0]?.displayName) {
    if (!attendees.includes(metadata.owners[0].displayName)) {
      attendees.push(metadata.owners[0].displayName);
    }
  }

  return attendees;
}
