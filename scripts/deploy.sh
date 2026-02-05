#!/bin/bash

# Meeting Task Bot - Deploy Script
# Deploys all Cloud Functions

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Meeting Task Bot - Deploy${NC}"
echo -e "${GREEN}========================================${NC}"

# Check if PROJECT_ID is set
if [ -z "$PROJECT_ID" ]; then
    echo -e "${RED}Error: PROJECT_ID environment variable is not set${NC}"
    echo "Usage: PROJECT_ID=your-project-id REGION=us-central1 ./deploy.sh"
    exit 1
fi

REGION=${REGION:-us-central1}
SERVICE_ACCOUNT="meeting-task-bot@$PROJECT_ID.iam.gserviceaccount.com"

echo -e "${YELLOW}Deploying to project: $PROJECT_ID (region: $REGION)${NC}"

# Build TypeScript
echo -e "\n${GREEN}[1/5] Building TypeScript...${NC}"
npm run build

# Deploy processTranscript function
echo -e "\n${GREEN}[2/5] Deploying processTranscript function...${NC}"
gcloud functions deploy processTranscript \
  --gen2 \
  --runtime=nodejs20 \
  --region=$REGION \
  --trigger-topic=meeting-transcripts \
  --entry-point=processTranscript \
  --source=. \
  --service-account=$SERVICE_ACCOUNT \
  --set-secrets="OPENAI_API_KEY=openai-api-key:latest,CLICKUP_API_KEY=clickup-api-key:latest" \
  --memory=512MB \
  --timeout=300s \
  --quiet

# Deploy handleChatInteraction function
echo -e "\n${GREEN}[3/5] Deploying handleChatInteraction function...${NC}"
gcloud functions deploy handleChatInteraction \
  --gen2 \
  --runtime=nodejs20 \
  --region=$REGION \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point=handleChatInteraction \
  --source=. \
  --service-account=$SERVICE_ACCOUNT \
  --set-secrets="CLICKUP_API_KEY=clickup-api-key:latest" \
  --memory=256MB \
  --timeout=60s \
  --quiet

# Deploy setupDriveWatchers function
echo -e "\n${GREEN}[4/5] Deploying setupDriveWatchers function...${NC}"
gcloud functions deploy setupDriveWatchers \
  --gen2 \
  --runtime=nodejs20 \
  --region=$REGION \
  --trigger-http \
  --entry-point=setupDriveWatchers \
  --source=. \
  --service-account=$SERVICE_ACCOUNT \
  --memory=256MB \
  --timeout=120s \
  --quiet

# Deploy driveWebhook function
echo -e "\n${GREEN}[5/5] Deploying driveWebhook function...${NC}"
gcloud functions deploy driveWebhook \
  --gen2 \
  --runtime=nodejs20 \
  --region=$REGION \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point=driveWebhook \
  --source=. \
  --service-account=$SERVICE_ACCOUNT \
  --set-secrets="OPENAI_API_KEY=openai-api-key:latest,CLICKUP_API_KEY=clickup-api-key:latest" \
  --memory=256MB \
  --timeout=60s \
  --quiet

# Get function URLs
echo -e "\n${GREEN}Deployment complete!${NC}"
echo ""
echo -e "${YELLOW}Function URLs:${NC}"
CHAT_URL=$(gcloud functions describe handleChatInteraction --region=$REGION --format='value(serviceConfig.uri)')
WEBHOOK_URL=$(gcloud functions describe driveWebhook --region=$REGION --format='value(serviceConfig.uri)')
WATCHERS_URL=$(gcloud functions describe setupDriveWatchers --region=$REGION --format='value(serviceConfig.uri)')

echo "  Chat Webhook:     $CHAT_URL"
echo "  Drive Webhook:    $WEBHOOK_URL"
echo "  Setup Watchers:   $WATCHERS_URL"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Configure Google Chat bot with endpoint: $CHAT_URL"
echo "2. Initialize Drive watchers:"
echo "   curl -X POST '$WATCHERS_URL?mode=full' \\"
echo "     -H 'Authorization: Bearer \$(gcloud auth print-identity-token)' \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"webhookUrl\": \"$WEBHOOK_URL\"}'"
echo ""
echo "3. Create Cloud Scheduler job for watcher renewal:"
echo "   gcloud scheduler jobs create http renew-drive-watchers \\"
echo "     --schedule='0 0 * * *' \\"
echo "     --uri='$WATCHERS_URL' \\"
echo "     --http-method=POST \\"
echo "     --message-body='{\"webhookUrl\": \"$WEBHOOK_URL\"}' \\"
echo "     --oidc-service-account-email=$SERVICE_ACCOUNT"
