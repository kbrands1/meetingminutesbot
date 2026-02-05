import { foldersConfig } from '../config/index.js';
import type { FolderConfig } from '../types/index.js';

/**
 * Get the configuration for a specific folder ID.
 * If the folder is not found, returns default config with a warning logged.
 */
export function getFolderConfig(folderId: string): FolderConfig {
  const folder = foldersConfig.folders.find(f => f.id === folderId);

  if (folder) {
    return folder;
  }

  // Return default config with the unknown folder ID logged
  console.warn(`Unknown folder ID: ${folderId}, using default config`);
  return {
    id: folderId,
    name: 'Unknown Folder',
    ...foldersConfig.defaultConfig
  };
}

/**
 * Get the single ClickUp list ID for all meeting tasks.
 */
export function getClickUpListId(): string {
  return foldersConfig.clickupListId;
}

/**
 * Get all configured folder IDs for setting up watchers.
 */
export function getAllFolderIds(): string[] {
  return foldersConfig.folders.map(f => f.id);
}

/**
 * Get all folder configurations.
 */
export function getAllFolderConfigs(): FolderConfig[] {
  return foldersConfig.folders;
}

/**
 * Check if a folder ID is configured (not using default config).
 */
export function isFolderConfigured(folderId: string): boolean {
  return foldersConfig.folders.some(f => f.id === folderId);
}

/**
 * Get folder config by name (case-insensitive).
 */
export function getFolderConfigByName(folderName: string): FolderConfig | null {
  const normalizedName = folderName.toLowerCase();
  return foldersConfig.folders.find(
    f => f.name.toLowerCase() === normalizedName
  ) || null;
}

/**
 * Get all users that should be notified for a specific folder.
 * Combines global notify users with folder-specific notify users.
 */
export function getNotifyUsers(folderId: string): string[] {
  const folderConfig = getFolderConfig(folderId);
  const globalUsers = foldersConfig.globalNotifyUsers || [];
  const folderUsers = folderConfig.alwaysNotifyUsers || [];

  // Combine and deduplicate
  return [...new Set([...globalUsers, ...folderUsers])];
}

/**
 * Get global notify users (users notified for all folders).
 */
export function getGlobalNotifyUsers(): string[] {
  return foldersConfig.globalNotifyUsers || [];
}
