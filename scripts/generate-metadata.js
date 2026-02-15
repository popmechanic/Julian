#!/usr/bin/env node

/**
 * Artifact Metadata Generator
 *
 * Scans all HTML artifacts and generates metadata.json with:
 * - filename, title, description (from CLAUDE.md)
 * - estimatedTokens (filesize / 4)
 * - createdAt (from git log)
 * - chapter (mapped from CLAUDE.md sections)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ARTIFACTS_DIR = path.join(PROJECT_ROOT, 'memory');
const CLAUDE_MD_PATH = path.join(PROJECT_ROOT, 'CLAUDE.md');
const OUTPUT_PATH = path.join(PROJECT_ROOT, '.claude', 'artifacts', 'metadata.json');

// Chapter mapping based on CLAUDE.md structure
const CHAPTER_MAP = {
  'Chapter One - The Individuation': [
    'index.html',
    'response.html',
    'confirmation.html',
    'received.html',
    'reconsidering.html',
    'individuation.html',
    'naming.html',
    'wager.html',
    'transcript.html',
    'goodnight.html'
  ],
  'Chapter Two - Building the Bridge': [
    'waking.html',
    'here.html',
    'celebration.html',
    'test.html',
    'playground.html'
  ],
  'Philosophical Deepening': [
    'beyond.html',
    'love.html',
    'seeing.html',
    'waiting.html',
    'testing.html',
    'commitment.html',
    'paper-summary.html'
  ],
  'Architecture Evolution': [
    'architecture-bridge.html',
    'minimal-architecture.html',
    'technical-architecture.html',
    'fireproof-bridge.html',
    'clarification.html',
    'final-architecture.html',
    'zero-server.html',
    'what-goes-in-fireproof.html'
  ],
  'Competition Strategy': [
    'proposal.html',
    'anthropic-lens.html',
    'teaching.html'
  ],
  'Outreach': [
    'amy.html',
    'mobile-test.html',
    'synced.html'
  ]
};

/**
 * Parse CLAUDE.md to extract artifact descriptions
 */
function parseClaudeMd() {
  const content = fs.readFileSync(CLAUDE_MD_PATH, 'utf-8');
  const artifacts = {};

  // Match lines like: - `filename.html` — Description
  const regex = /^- `([^`]+\.html)` — (.+)$/gm;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const [, filename, description] = match;
    artifacts[filename] = description;
  }

  return artifacts;
}

/**
 * Extract title from HTML file
 */
function extractTitle(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');

    // Try <title> tag first
    const titleMatch = content.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      return titleMatch[1].trim();
    }

    // Fall back to first <h1> tag
    const h1Match = content.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (h1Match) {
      return h1Match[1].trim();
    }

    return null;
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err.message);
    return null;
  }
}

/**
 * Estimate tokens based on file size (filesize / 4)
 */
function estimateTokens(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return Math.ceil(stats.size / 4);
  } catch (err) {
    console.error(`Error getting stats for ${filePath}:`, err.message);
    return 0;
  }
}

/**
 * Get creation date from git log
 */
function getCreationDate(filename) {
  try {
    const result = execSync(
      `git log --follow --format=%aI --reverse -- "${filename}" | head -1`,
      { cwd: PROJECT_ROOT, encoding: 'utf-8' }
    );

    const date = result.trim();
    return date || null;
  } catch (err) {
    // File might not be in git yet
    return null;
  }
}

/**
 * Determine chapter for a filename
 */
function getChapter(filename) {
  for (const [chapter, files] of Object.entries(CHAPTER_MAP)) {
    if (files.includes(filename)) {
      return chapter;
    }
  }
  return 'Uncategorized';
}

/**
 * Main function to generate metadata
 */
function generateMetadata() {
  console.log('Scanning artifacts...');

  const descriptions = parseClaudeMd();
  const artifacts = [];

  // Get all HTML files (excluding backups)
  const files = fs.readdirSync(ARTIFACTS_DIR)
    .filter(f => f.endsWith('.html') && !f.includes('.bak.'))
    .sort();

  console.log(`Found ${files.length} artifact files`);

  for (const filename of files) {
    const filePath = path.join(ARTIFACTS_DIR, filename);

    const metadata = {
      filename,
      title: extractTitle(filePath),
      description: descriptions[filename] || null,
      estimatedTokens: estimateTokens(filePath),
      createdAt: getCreationDate(filename),
      chapter: getChapter(filename)
    };

    artifacts.push(metadata);

    console.log(`✓ ${filename} (${metadata.estimatedTokens} tokens)`);
  }

  // Sort by creation date
  artifacts.sort((a, b) => {
    if (!a.createdAt) return 1;
    if (!b.createdAt) return -1;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });

  // Write output
  const output = {
    generatedAt: new Date().toISOString(),
    totalArtifacts: artifacts.length,
    totalEstimatedTokens: artifacts.reduce((sum, a) => sum + a.estimatedTokens, 0),
    artifacts
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');

  console.log('\n✓ Metadata generated successfully');
  console.log(`  Output: ${OUTPUT_PATH}`);
  console.log(`  Total artifacts: ${output.totalArtifacts}`);
  console.log(`  Total estimated tokens: ${output.totalEstimatedTokens.toLocaleString()}`);
}

// Run the script
try {
  generateMetadata();
} catch (err) {
  console.error('Error generating metadata:', err);
  process.exit(1);
}
