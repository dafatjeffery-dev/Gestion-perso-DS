// Fichiers donnés à l'utilisateur : boîte « Enregistrer sous » dans l'application Mac,
// téléchargement dans l'aperçu navigateur. Aucun envoi vers un service externe.

import { isTauri } from '../storage/tauriDriver';

export async function saveFile(name: string, content: Uint8Array | string, mime: string): Promise<string | null> {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await save({ defaultPath: name });
    if (!path) return null;
    await invoke('save_file', { path, bytes: Array.from(bytes) });
    return path;
  }
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export async function sha256OfBytes(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
