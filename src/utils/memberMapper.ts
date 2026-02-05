import { getWorkspaceMembers, findMemberByName } from '../services/clickupService.js';
import type { ClickUpMember } from '../types/index.js';

/**
 * Get ClickUp member ID from a name mentioned in transcript.
 * Returns the numeric member ID or null if not found.
 */
export async function getClickUpMemberId(name: string): Promise<number | null> {
  const member = await findMemberByName(name);
  return member?.id || null;
}

/**
 * Get email from a name using ClickUp workspace members.
 */
export async function getEmailFromName(name: string): Promise<string | null> {
  const member = await findMemberByName(name);
  return member?.email || null;
}

/**
 * Map a list of names to ClickUp member IDs.
 * Returns an object with successful mappings and unmapped names.
 */
export async function mapNamesToClickUpIds(names: string[]): Promise<{
  mappedIds: number[];
  unmappedNames: string[];
}> {
  const mappedIds: number[] = [];
  const unmappedNames: string[] = [];

  for (const name of names) {
    const memberId = await getClickUpMemberId(name);
    if (memberId) {
      mappedIds.push(memberId);
    } else {
      unmappedNames.push(name);
    }
  }

  return { mappedIds, unmappedNames };
}

/**
 * Get all team members from ClickUp workspace.
 */
export async function getAllTeamMembers(): Promise<ClickUpMember[]> {
  return getWorkspaceMembers();
}

/**
 * Extract attendees from a transcript based on speaker patterns.
 */
export function extractAttendeesFromTranscript(transcript: string): string[] {
  const attendees = new Set<string>();

  // Common speaker patterns in transcripts
  const patterns = [
    /^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?):/gm,  // "John:" or "John Smith:"
    /^\[([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\]/gm, // "[John]" or "[John Smith]"
    /^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+said:/gm, // "John said:"
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(transcript)) !== null) {
      const name = match[1].trim();
      // Filter out common non-name patterns
      if (!isLikelyTimestamp(name) && name.length > 1) {
        attendees.add(name);
      }
    }
  }

  return Array.from(attendees);
}

/**
 * Check if a string looks like a timestamp rather than a name.
 */
function isLikelyTimestamp(str: string): boolean {
  // Check for time patterns
  return /^\d{1,2}:\d{2}/.test(str) || /^[AP]M$/i.test(str);
}

/**
 * Try to resolve an assignee name to a ClickUp member.
 * Returns both the member (if found) and whether it was an exact match.
 */
export async function resolveAssignee(name: string): Promise<{
  member: ClickUpMember | null;
  confidence: 'exact' | 'partial' | 'none';
}> {
  if (!name) {
    return { member: null, confidence: 'none' };
  }

  const members = await getWorkspaceMembers();
  const normalizedName = name.toLowerCase().trim();

  // Try exact match on username or email
  const exactMatch = members.find(m =>
    m.username.toLowerCase() === normalizedName ||
    m.email.toLowerCase() === normalizedName
  );

  if (exactMatch) {
    return { member: exactMatch, confidence: 'exact' };
  }

  // Try partial match
  const partialMatch = await findMemberByName(name);
  if (partialMatch) {
    return { member: partialMatch, confidence: 'partial' };
  }

  return { member: null, confidence: 'none' };
}
