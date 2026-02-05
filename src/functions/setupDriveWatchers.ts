import type { Request, Response } from 'express';
import {
  setupAllFolderWatchers,
  renewExpiringWatchers
} from '../services/driveService.js';
import { getAllFolderConfigs } from '../utils/folderConfigResolver.js';
import { getEnvVar } from '../config/index.js';

/**
 * Cloud Function to set up or renew Drive watchers for all configured folders.
 * This should be called on deployment and scheduled to run daily via Cloud Scheduler.
 */
export async function setupDriveWatchers(
  req: Request,
  res: Response
): Promise<void> {
  const mode = req.body?.mode || req.query?.mode || 'renew';

  try {
    // Get the webhook URL from environment or request
    const webhookUrl = req.body?.webhookUrl ||
      getEnvVar('DRIVE_WEBHOOK_URL', '') ||
      `https://${req.headers.host}/driveWebhook`;

    if (!webhookUrl) {
      res.status(400).json({
        error: 'Missing webhook URL. Set DRIVE_WEBHOOK_URL or pass webhookUrl in request body.'
      });
      return;
    }

    console.log(`Setting up Drive watchers with webhook URL: ${webhookUrl}`);

    if (mode === 'full') {
      // Full setup - useful for initial deployment or after config changes
      console.log('Performing full watcher setup');
      await setupAllFolderWatchers(webhookUrl);

      const folders = getAllFolderConfigs();
      res.json({
        success: true,
        message: `Set up watchers for ${folders.length} folders`,
        folders: folders.map(f => ({ id: f.id, name: f.name }))
      });
    } else {
      // Renewal mode - only renew watchers that are expiring soon
      console.log('Renewing expiring watchers');
      await renewExpiringWatchers(webhookUrl);

      res.json({
        success: true,
        message: 'Renewed expiring watchers'
      });
    }

  } catch (error) {
    console.error('Error setting up Drive watchers:', error);
    res.status(500).json({
      error: 'Failed to set up Drive watchers',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

/**
 * Cloud Function to handle Drive push notifications.
 * This receives notifications when files change in watched folders.
 */
export async function driveWebhook(
  req: Request,
  res: Response
): Promise<void> {
  const resourceState = req.headers['x-goog-resource-state'] as string;
  const channelId = req.headers['x-goog-channel-id'] as string;
  const resourceId = req.headers['x-goog-resource-id'] as string;

  console.log(`Drive webhook: state=${resourceState}, channel=${channelId}`);

  // Only process 'change' or 'update' notifications (not 'sync')
  if (resourceState === 'sync') {
    console.log('Sync notification, ignoring');
    res.status(200).send('OK');
    return;
  }

  // Handle both 'change' and 'update' states from Drive
  if (resourceState === 'change' || resourceState === 'update') {
    // Extract folder ID from channel ID (format: meeting-bot-{folderId}-{timestamp})
    const folderIdMatch = channelId.match(/meeting-bot-(.+?)-\d+$/);
    if (!folderIdMatch) {
      console.warn(`Could not extract folder ID from channel: ${channelId}`);
      res.status(200).send('OK');
      return;
    }

    const folderId = folderIdMatch[1];
    console.log(`Change detected in folder: ${folderId}`);

    try {
      // Publish to Pub/Sub for processing
      // The actual file detection will be done in the processTranscript function
      // by listing recent files in the folder
      await publishFolderChange(folderId);
      console.log(`Successfully published folder change for: ${folderId}`);
    } catch (error) {
      console.error(`Error publishing folder change:`, error);
    }
  }

  // Acknowledge the request after processing
  res.status(200).send('OK');
}

/**
 * Publish a folder change event to Pub/Sub.
 */
async function publishFolderChange(folderId: string): Promise<void> {
  const { PubSub } = await import('@google-cloud/pubsub');
  const { getConfig } = await import('../config/index.js');
  const { listRecentTranscripts, isValidTranscript } = await import('../services/driveService.js');

  const config = getConfig();
  const pubsub = new PubSub();
  const topic = pubsub.topic(config.gcp.pubsubTopic);

  // Get recent files in the folder
  const recentFiles = await listRecentTranscripts(folderId, 5);

  // Filter for valid transcripts created in the last hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  for (const file of recentFiles) {
    const fileCreatedAt = new Date(file.createdTime);

    if (fileCreatedAt > oneHourAgo && isValidTranscript(file)) {
      console.log(`Publishing new transcript: ${file.name}`);

      const message = {
        fileId: file.id,
        folderId: folderId
      };

      await topic.publishMessage({
        data: Buffer.from(JSON.stringify(message))
      });
    }
  }
}
