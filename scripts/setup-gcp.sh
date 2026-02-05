#!/bin/bash

# Meeting Task Bot - GCP Setup Script
# Run this after creating your GCP project

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Meeting Task Bot - GCP Setup${NC}"
echo -e "${GREEN}========================================${NC}"

# Check if PROJECT_ID is set
if [ -z "$PROJECT_ID" ]; then
    echo -e "${RED}Error: PROJECT_ID environment variable is not set${NC}"
    echo "Usage: PROJECT_ID=your-project-id ./setup-gcp.sh"
    exit 1
fi

echo -e "${YELLOW}Setting up project: $PROJECT_ID${NC}"

# Set the project
echo -e "\n${GREEN}[1/8] Setting GCP project...${NC}"
gcloud config set project $PROJECT_ID

# Enable required APIs
echo -e "\n${GREEN}[2/8] Enabling required APIs...${NC}"
gcloud services enable \
  cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com \
  pubsub.googleapis.com \
  drive.googleapis.com \
  chat.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  cloudscheduler.googleapis.com \
  run.googleapis.com

# Create Pub/Sub topic
echo -e "\n${GREEN}[3/8] Creating Pub/Sub topic...${NC}"
gcloud pubsub topics create meeting-transcripts --quiet 2>/dev/null || echo "Topic already exists"

# Create Firestore database (if not exists)
echo -e "\n${GREEN}[4/8] Creating Firestore database...${NC}"
gcloud firestore databases create --location=us-central --quiet 2>/dev/null || echo "Firestore already exists"

# Create service account
echo -e "\n${GREEN}[5/8] Creating service account...${NC}"
gcloud iam service-accounts create meeting-task-bot \
  --display-name="Meeting Task Bot" \
  --quiet 2>/dev/null || echo "Service account already exists"

# Grant permissions
echo -e "\n${GREEN}[6/8] Granting IAM permissions...${NC}"
SERVICE_ACCOUNT="meeting-task-bot@$PROJECT_ID.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SERVICE_ACCOUNT" \
  --role="roles/secretmanager.secretAccessor" \
  --quiet

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SERVICE_ACCOUNT" \
  --role="roles/datastore.user" \
  --quiet

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SERVICE_ACCOUNT" \
  --role="roles/pubsub.publisher" \
  --quiet

echo -e "\n${GREEN}[7/8] Setting up secrets...${NC}"
echo -e "${YELLOW}You'll need to add these secrets manually:${NC}"
echo ""
echo "  # OpenAI API Key:"
echo "  echo -n 'sk-your-key' | gcloud secrets create openai-api-key --data-file=-"
echo ""
echo "  # ClickUp API Key:"
echo "  echo -n 'pk_your-key' | gcloud secrets create clickup-api-key --data-file=-"
echo ""

echo -e "\n${GREEN}[8/8] Setup complete!${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Add your API keys as secrets (see commands above)"
echo "2. Update config/default.json with your project ID"
echo "3. Update config/folders.json with your Drive folder IDs and ClickUp list ID"
echo "4. Run 'npm run build' to compile TypeScript"
echo "5. Run the deploy script: ./scripts/deploy.sh"
echo ""
echo -e "${GREEN}Project ID: $PROJECT_ID${NC}"
echo -e "${GREEN}Service Account: $SERVICE_ACCOUNT${NC}"
