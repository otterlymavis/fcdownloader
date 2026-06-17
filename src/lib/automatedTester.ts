import { extractFromSocialUrl } from './platformExtractors';
import { extractViaServer } from './serverExtractor';
import { DetectedMedia } from '../types';

export interface StrategyTestResult {
  strategy: string;
  success: boolean;
  error?: string;
  mediaCount: number;
  confidence: number;
}

export interface AutomatedTestPayload {
  url: string;
  timestamp: number;
  results: StrategyTestResult[];
}

export async function runAutomatedStrategyTest(url: string, reportUrl: string) {
  const payload: AutomatedTestPayload = {
    url,
    timestamp: Date.now(),
    results: [],
  };

  // Test Strategy 1: Server-Extraction
  try {
    const serverMedia = await extractViaServer(url);
    payload.results.push({
      strategy: 'SERVER',
      success: serverMedia.length > 0,
      mediaCount: serverMedia.length,
      confidence: Math.max(0, ...serverMedia.map(m => m.confidence ?? 0)),
    });
  } catch (e: any) {
    payload.results.push({
      strategy: 'SERVER',
      success: false,
      error: String(e?.message ?? e).slice(0, 240),
      mediaCount: 0,
      confidence: 0,
    });
  }

  // Test Strategy 2: On-Device (Platform + Generic)
  // skipServer: true isolates the on-device tier; server path is already tested above.
  try {
    const deviceMedia = await extractFromSocialUrl(url, { skipServer: true });
    payload.results.push({
      strategy: 'ON-DEVICE',
      success: deviceMedia.length > 0,
      mediaCount: deviceMedia.length,
      confidence: Math.max(0, ...deviceMedia.map(m => m.confidence ?? 0)),
    });
  } catch (e: any) {
    payload.results.push({
      strategy: 'ON-DEVICE',
      success: false,
      error: String(e?.message ?? e).slice(0, 240),
      mediaCount: 0,
      confidence: 0,
    });
  }

  // POST back to the orchestrator Python script
  try {
    await fetch(reportUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('[AutomatedTester] Failed to POST results:', err);
  }
}
