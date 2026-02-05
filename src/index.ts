/**
 * Meeting Task Bot - Main Entry Point
 *
 * This file exports all Cloud Functions for deployment.
 */

// Export Cloud Functions
export { processTranscript } from './functions/processTranscript.js';
export { handleChatInteraction } from './functions/handleChatInteraction.js';
export { setupDriveWatchers, driveWebhook } from './functions/setupDriveWatchers.js';

// Re-export services for testing and direct use
export * as driveService from './services/driveService.js';
export * as chatService from './services/chatService.js';
export * as clickupService from './services/clickupService.js';
export * as openaiService from './services/openaiService.js';
export * as firestoreService from './services/firestoreService.js';

// Re-export utilities
export * as folderConfigResolver from './utils/folderConfigResolver.js';
export * as dateResolver from './utils/dateResolver.js';
export * as memberMapper from './utils/memberMapper.js';
export * as transcriptParser from './utils/transcriptParser.js';

// Re-export types
export * from './types/index.js';
