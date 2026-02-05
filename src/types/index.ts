// Folder configuration types
export interface NotifyConfig {
  type: 'space' | 'dm_owner';
  spaceId?: string;
}

export interface FolderConfig {
  id: string;
  name: string;
  taskPrefix: string;
  notifyChat: NotifyConfig;
  confidential?: boolean;
  alwaysNotifyUsers?: string[];  // List of emails to always notify for this folder
}

export interface FoldersConfiguration {
  clickupListId: string;  // Single list for all meeting tasks
  folders: FolderConfig[];
  defaultConfig: Omit<FolderConfig, 'id' | 'name'>;
  globalNotifyUsers?: string[];  // Users to notify for ALL folders
}

// Task extraction types
export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low';
export type ExtractionType = 'explicit' | 'implicit';

export interface ExtractedTask {
  title: string;
  description: string;
  suggested_assignee: string | null;
  suggested_due: string | null;
  priority: TaskPriority;
  source_quote: string;
  confidence: number;
  extraction_type: ExtractionType;
}

export interface ExtractedTaskWithConfig extends ExtractedTask {
  clickupListId: string;
}

export interface MeetingAnalysis {
  tasks: ExtractedTask[];
  meeting_summary: string;
  decisions: string[];
}

// Meeting info types
export interface MeetingInfo {
  title: string;
  date: string;
  attendees: string[];
  folderId: string;
  folderName: string;
}

// Pending tasks storage types
export interface PendingTasksData {
  fileId: string;
  folderId: string;
  folderConfig: FolderConfig;
  tasks: ExtractedTaskWithConfig[];
  meetingInfo: MeetingInfo;
  analysis: MeetingAnalysis;
  createdAt: Date;
  status: 'pending' | 'processing' | 'completed';
}

// Google Drive types
export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  modifiedTime: string;
  parents?: string[];
  owners?: Array<{
    emailAddress: string;
    displayName?: string;
  }>;
  webViewLink?: string;
}

// Pub/Sub message types
export interface TranscriptPubSubMessage {
  fileId: string;
  folderId?: string;
}

// Google Chat types
export interface ChatCardInteraction {
  type: string; // 'MESSAGE' | 'CARD_CLICKED' | 'ADDED_TO_SPACE' | 'REMOVED_FROM_SPACE' | 'UNKNOWN'
  eventTime?: string;
  message?: {
    name: string;
    sender: {
      name: string;
      displayName: string;
      email?: string;
    };
    text?: string;
  };
  action?: {
    actionMethodName: string;
    parameters: Array<{
      key: string;
      value: string;
    }>;
  };
  user?: {
    name: string;
    displayName: string;
    email?: string;
  };
  space?: {
    name: string;
    displayName?: string;
    type: 'DM' | 'ROOM';
  };
  common?: {
    formInputs?: Record<string, {
      stringInputs?: {
        value: string[];
      };
    }>;
  };
}

// ClickUp types
export interface ClickUpTask {
  id: string;
  name: string;
  description?: string;
  status: string;
  priority?: {
    id: string;
    priority: string;
    color: string;
  };
  assignees?: Array<{
    id: number;
    username: string;
    email: string;
  }>;
  due_date?: string;
  url: string;
}

export interface ClickUpCreateTaskPayload {
  name: string;
  description?: string;
  assignees?: number[];
  due_date?: number;
  priority?: number;
  custom_fields?: Array<{
    id: string;
    value: string | number | boolean;
  }>;
}

export interface ClickUpMember {
  id: number;
  username: string;
  email: string;
  color?: string;
  profilePicture?: string;
}

// Configuration types
export interface AppConfig {
  gcp: {
    projectId: string;
    pubsubTopic: string;
    firestoreCollection: string;
  };
  openai: {
    model: string;
    fallbackModel: string;
    confidenceThreshold: number;
  };
  clickup: {
    workspaceId: string;
  };
  taskDefaults: {
    priority: TaskPriority;
    includeTranscriptLink: boolean;
  };
  driveWatcher: {
    renewalIntervalHours: number;
  };
}

// Watcher channel types
export interface WatcherChannel {
  channelId: string;
  folderId: string;
  resourceId?: string;
  expiration: Date;
  createdAt: Date;
}
