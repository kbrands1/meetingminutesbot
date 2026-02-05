import { google, drive_v3 } from 'googleapis';
import { Firestore } from '@google-cloud/firestore';
import { getAllFolderIds } from '../utils/folderConfigResolver.js';
import type { DriveFileMetadata, WatcherChannel } from '../types/index.js';
import { getConfig } from '../config/index.js';

const config = getConfig();
const firestore = new Firestore();
const WATCHERS_COLLECTION = 'drive-watchers';

// Initialize Drive client with default credentials
function getDriveClient(): drive_v3.Drive {
  const auth = new google.auth.GoogleAuth({
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly'
    ]
  });
  return google.drive({ version: 'v3', auth });
}

/**
 * Set up push notifications for all configured folders.
 */
export async function setupAllFolderWatchers(webhookUrl: string): Promise<void> {
  const folderIds = getAllFolderIds();

  for (const folderId of folderIds) {
    try {
      await setupFolderWatcher(folderId, webhookUrl);
      console.log(`Watcher set up for folder: ${folderId}`);
    } catch (error) {
      console.error(`Failed to set up watcher for folder ${folderId}:`, error);
    }
  }
}

/**
 * Set up a watch channel for a specific folder.
 * Note: Drive push notifications require periodic renewal (max 24h for most, 7 days for some)
 */
async function setupFolderWatcher(folderId: string, webhookUrl: string): Promise<void> {
  const drive = getDriveClient();

  // First, stop any existing watcher for this folder
  await stopExistingWatcher(folderId);

  const channelId = `meeting-bot-${folderId}-${Date.now()}`;

  // Calculate expiration (use 23 hours to be safe, renew before expiration)
  const expirationMs = Date.now() + (23 * 60 * 60 * 1000);

  const response = await drive.files.watch({
    fileId: folderId,
    requestBody: {
      id: channelId,
      type: 'web_hook',
      address: webhookUrl,
      expiration: String(expirationMs)
    }
  });

  // Store channel info in Firestore for renewal management
  await storeWatcherChannel(folderId, channelId, response.data.resourceId || undefined, expirationMs);
}

/**
 * Stop an existing watcher for a folder.
 */
async function stopExistingWatcher(folderId: string): Promise<void> {
  const drive = getDriveClient();

  try {
    const doc = await firestore.collection(WATCHERS_COLLECTION).doc(folderId).get();
    if (doc.exists) {
      const data = doc.data() as WatcherChannel;
      await drive.channels.stop({
        requestBody: {
          id: data.channelId,
          resourceId: data.resourceId
        }
      });
      console.log(`Stopped existing watcher for folder: ${folderId}`);
    }
  } catch (error) {
    // Ignore errors when stopping - channel may have already expired
    console.log(`No existing watcher to stop for folder: ${folderId}`);
  }
}

/**
 * Store watcher channel info in Firestore.
 */
async function storeWatcherChannel(
  folderId: string,
  channelId: string,
  resourceId: string | undefined,
  expirationMs: number
): Promise<void> {
  const watcherData: WatcherChannel = {
    channelId,
    folderId,
    resourceId,
    expiration: new Date(expirationMs),
    createdAt: new Date()
  };

  await firestore.collection(WATCHERS_COLLECTION).doc(folderId).set(watcherData);
}

/**
 * Get the parent folder ID from a file.
 */
export async function getFileFolderId(fileId: string): Promise<string | null> {
  const drive = getDriveClient();

  const response = await drive.files.get({
    fileId: fileId,
    fields: 'parents'
  });

  return response.data.parents?.[0] || null;
}

/**
 * Get file metadata including owner information.
 */
export async function getFileMetadata(fileId: string): Promise<DriveFileMetadata> {
  const drive = getDriveClient();

  const response = await drive.files.get({
    fileId: fileId,
    fields: 'id,name,mimeType,createdTime,modifiedTime,parents,owners,webViewLink'
  });

  return {
    id: response.data.id!,
    name: response.data.name!,
    mimeType: response.data.mimeType!,
    createdTime: response.data.createdTime!,
    modifiedTime: response.data.modifiedTime!,
    parents: response.data.parents || undefined,
    owners: response.data.owners?.map(o => ({
      emailAddress: o.emailAddress!,
      displayName: o.displayName || undefined
    })),
    webViewLink: response.data.webViewLink || undefined
  };
}

/**
 * Get file content as text.
 * Handles different file types (txt, docx, Google Docs).
 */
export async function getFileContent(fileId: string): Promise<string> {
  const drive = getDriveClient();

  // First get the file metadata to determine type
  const metadata = await getFileMetadata(fileId);

  // For Google Docs, export as plain text
  if (metadata.mimeType === 'application/vnd.google-apps.document') {
    const response = await drive.files.export({
      fileId: fileId,
      mimeType: 'text/plain'
    });
    return response.data as string;
  }

  // For text files and other formats, download directly
  const response = await drive.files.get({
    fileId: fileId,
    alt: 'media'
  }, {
    responseType: 'text'
  });

  return response.data as string;
}

/**
 * List recent files in a folder that match transcript patterns.
 */
export async function listRecentTranscripts(
  folderId: string,
  maxResults: number = 10
): Promise<DriveFileMetadata[]> {
  const drive = getDriveClient();

  const response = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,createdTime,modifiedTime,parents,owners,webViewLink)',
    orderBy: 'createdTime desc',
    pageSize: maxResults
  });

  return (response.data.files || []).map(file => ({
    id: file.id!,
    name: file.name!,
    mimeType: file.mimeType!,
    createdTime: file.createdTime!,
    modifiedTime: file.modifiedTime!,
    parents: file.parents || undefined,
    owners: file.owners?.map(o => ({
      emailAddress: o.emailAddress!,
      displayName: o.displayName || undefined
    })),
    webViewLink: file.webViewLink || undefined
  }));
}

/**
 * Check if a file is a valid transcript based on name/type.
 */
export function isValidTranscript(metadata: DriveFileMetadata): boolean {
  const name = metadata.name.toLowerCase();
  const mimeType = metadata.mimeType;

  // Check for common transcript file extensions/types
  const validExtensions = ['.txt', '.vtt', '.srt', '.docx', '.doc'];
  const validMimeTypes = [
    'text/plain',
    'text/vtt',
    'application/vnd.google-apps.document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword'
  ];

  const hasValidExtension = validExtensions.some(ext => name.endsWith(ext));
  const hasValidMimeType = validMimeTypes.includes(mimeType);

  return hasValidExtension || hasValidMimeType;
}

/**
 * Renew all watchers that are expiring soon.
 */
export async function renewExpiringWatchers(webhookUrl: string): Promise<void> {
  const renewalThresholdMs = config.driveWatcher.renewalIntervalHours * 60 * 60 * 1000;
  const thresholdDate = new Date(Date.now() + renewalThresholdMs);

  const snapshot = await firestore.collection(WATCHERS_COLLECTION)
    .where('expiration', '<', thresholdDate)
    .get();

  for (const doc of snapshot.docs) {
    const data = doc.data() as WatcherChannel;
    try {
      await setupFolderWatcher(data.folderId, webhookUrl);
      console.log(`Renewed watcher for folder: ${data.folderId}`);
    } catch (error) {
      console.error(`Failed to renew watcher for folder ${data.folderId}:`, error);
    }
  }
}
