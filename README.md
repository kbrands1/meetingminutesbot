# Meeting Task Bot

A Google Chat bot that monitors Google Drive folders for meeting transcripts, uses OpenAI to extract tasks (both explicit callouts and implicit action items), sends interactive approval cards to meeting owners via Google Chat, and creates approved tasks in ClickUp.

## Architecture

```
Google Drive (multiple transcript folders)
    ├── /Brand A Meetings
    ├── /Brand B Meetings
    ├── /Operations Meetings
    └── /Leadership Meetings
              ↓ (file created in any folder)
Cloud Pub/Sub topic
              ↓
Cloud Function: processTranscript
              ↓
Identify source folder → Load folder-specific config
              ↓
OpenAI API → Extract tasks (explicit + implicit)
              ↓
Google Chat API → Send interactive cards to meeting owner
              ↓
User clicks "Create Task"
              ↓
Cloud Function: handleChatInteraction (webhook)
              ↓
ClickUp API → Create task in folder-specific list
              ↓
Google Chat API → Confirm creation
```

## Features

- **Multi-folder monitoring**: Each folder can route to different ClickUp lists
- **AI-powered task extraction**: Uses GPT-4o with structured outputs
- **Explicit task detection**: Recognizes patterns like "Create task X for Y due Z"
- **Implicit task detection**: Identifies commitments made in conversation
- **Interactive approval**: Users can edit task details before creation
- **Folder-specific configuration**: Task prefixes, notification routing, confidential mode
- **Automatic date resolution**: Converts "next Friday", "end of week" to ISO dates

## Prerequisites

- Node.js 20+
- Google Cloud Platform account
- OpenAI API key
- ClickUp API key
- Google Workspace with Google Chat enabled

## Setup

### 1. Clone and Install

```bash
cd meeting-task-bot
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

### 3. Configure Folders

Edit `config/folders.json` with your Google Drive folder IDs and ClickUp list IDs.

### 4. Configure Team Mapping

Edit `config/team-mapping.json` with your team members' details.

### 5. Deploy to Google Cloud

```bash
# Set project
gcloud config set project YOUR_PROJECT_ID

# Enable required APIs
gcloud services enable \
  cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com \
  pubsub.googleapis.com \
  drive.googleapis.com \
  chat.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  cloudscheduler.googleapis.com

# Create Pub/Sub topic
gcloud pubsub topics create meeting-transcripts

# Create secrets
echo -n "sk-xxxxx" | gcloud secrets create openai-api-key --data-file=-
echo -n "pk_xxxxx" | gcloud secrets create clickup-api-key --data-file=-

# Create service account
gcloud iam service-accounts create meeting-task-bot \
  --display-name="Meeting Task Bot"

# Grant permissions
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:meeting-task-bot@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:meeting-task-bot@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/datastore.user"

# Build TypeScript
npm run build

# Deploy functions
gcloud functions deploy processTranscript \
  --gen2 \
  --runtime=nodejs20 \
  --trigger-topic=meeting-transcripts \
  --entry-point=processTranscript \
  --service-account=meeting-task-bot@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --set-secrets="OPENAI_API_KEY=openai-api-key:latest,CLICKUP_API_KEY=clickup-api-key:latest" \
  --memory=512MB \
  --timeout=300s

gcloud functions deploy handleChatInteraction \
  --gen2 \
  --runtime=nodejs20 \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point=handleChatInteraction \
  --service-account=meeting-task-bot@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --set-secrets="CLICKUP_API_KEY=clickup-api-key:latest"

gcloud functions deploy setupDriveWatchers \
  --gen2 \
  --runtime=nodejs20 \
  --trigger-http \
  --entry-point=setupDriveWatchers \
  --service-account=meeting-task-bot@YOUR_PROJECT_ID.iam.gserviceaccount.com

# Create Cloud Scheduler job to renew Drive watchers daily
gcloud scheduler jobs create http renew-drive-watchers \
  --schedule="0 0 * * *" \
  --uri="https://REGION-YOUR_PROJECT_ID.cloudfunctions.net/setupDriveWatchers" \
  --http-method=POST \
  --oidc-service-account-email=meeting-task-bot@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

### 6. Configure Google Chat Bot

1. Go to Google Cloud Console → APIs & Services → Google Chat API
2. Configure the bot:
   - Name: "Meeting Task Bot"
   - Description: "Creates ClickUp tasks from meeting transcripts"
   - Functionality: Bot works in DMs and Spaces
   - Connection settings: HTTP endpoint → Cloud Function URL for handleChatInteraction
   - Permissions: Log errors to Cloud Logging

### 7. Initialize Drive Watchers

Call the setupDriveWatchers function with `mode=full`:

```bash
curl -X POST "https://REGION-YOUR_PROJECT_ID.cloudfunctions.net/setupDriveWatchers?mode=full" \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)"
```

## Configuration

### Folder Configuration (`config/folders.json`)

| Field | Description |
|-------|-------------|
| `id` | Google Drive folder ID |
| `name` | Human-readable name (for logging/cards) |
| `clickupListId` | Target ClickUp list for tasks from this folder |
| `defaultAssignees` | Email addresses to pre-populate if no assignee detected |
| `taskPrefix` | Prefix added to task titles (e.g., "[Brand A] Task name") |
| `notifyChat.type` | `space` (post to a Chat space) or `dm_owner` (DM the file owner) |
| `notifyChat.spaceId` | Chat space ID (if type is `space`) |
| `confidential` | If true, redact transcript content from task descriptions |

### Explicit Task Patterns

The bot recognizes these patterns as explicit task callouts:

- "Create task [name] for [person] due [date]"
- "Task for [person]: [description] by [date]"
- "Action item: [task] assigned to [person]"
- "[Person], can you [task] by [date]"
- "Adding a task - [person] to [task]"
- "Let's make that a task for [person]"
- "That's a task for [person], due [date]"

### Date Resolution

- "tomorrow" → meeting date + 1
- "next Friday" → next occurring Friday
- "end of week" → Friday of meeting week
- "in two weeks" → meeting date + 14
- "end of month" → last day of month
- "Q1" → March 31

## Testing

```bash
# Run tests
npm test

# Run specific test file
npm test -- src/utils/dateResolver.test.ts
```

## Development

```bash
# Watch mode
npm run dev

# Build
npm run build
```

## License

MIT
