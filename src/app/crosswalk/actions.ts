'use server';

import { revalidatePath } from 'next/cache';
import { IdResolver } from '@/ids/resolver';
import { clearUnmatched, ignoreUnmatched } from '@/ids/unmatched';

// Sanctioned control-plane writes from the web process: manual ID mappings.

export async function mapAsset(formData: FormData): Promise<void> {
  const source = String(formData.get('source') ?? '');
  const sourceKey = String(formData.get('sourceKey') ?? '');
  const sleeperId = String(formData.get('sleeperId') ?? '');
  if (!source || !sourceKey || !sleeperId) return;
  new IdResolver().record(source, sourceKey, sleeperId, 'manual');
  clearUnmatched(source, sourceKey);
  revalidatePath('/crosswalk');
}

// Sticky: the row stays with ignored=1 so re-ingestion neither resurfaces it
// nor counts it as a warning.
export async function dismissAsset(formData: FormData): Promise<void> {
  const source = String(formData.get('source') ?? '');
  const sourceKey = String(formData.get('sourceKey') ?? '');
  if (!source || !sourceKey) return;
  ignoreUnmatched(source, sourceKey);
  revalidatePath('/crosswalk');
}
