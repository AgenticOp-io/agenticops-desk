import { Capacitor, registerPlugin } from "@capacitor/core";

// Native side: android/.../DeskWatchPlugin.java. Alerts while the app is closed, the system browser, and the Keystore vault.
export const DeskWatch = registerPlugin<{
  setup(o: { token: string; repos: string }): Promise<void>;
  stop(): Promise<void>;
  ask(): Promise<void>;
  open(o: { url: string }): Promise<void>;
  status(): Promise<{ enabled: boolean }>;
  secretGet(o: { key: string }): Promise<{ value: string }>;
  secretSet(o: { key: string; value: string }): Promise<void>;
  cloud(o: { url: string; pin: string; token: string; body?: string }): Promise<{ status: number; body: string }>;
}>("DeskWatch");
export const native = Capacitor.isNativePlatform();

// The GitHub token, the phone agent's API key and the cloud desk token. On the phone they live in the Keystore vault
// (Vault.java); a browser preview has no vault and keeps them in localStorage. Read once at start so getters stay sync.
const KEYS = ["gh.token", "phone.ai", "cloud.desk"] as const;
type Key = (typeof KEYS)[number];
const mem = new Map<Key, string>();

export async function loadSecrets() {
  for (const k of KEYS) {
    const old = localStorage.getItem(k) ?? "";
    if (!native) {
      mem.set(k, old);
      continue;
    }
    let value = await DeskWatch.secretGet({ key: k }).then((r) => r.value, () => "");
    // Builds before the vault kept these in localStorage: move them in once, and only drop the old copy once it is sealed.
    if (old) {
      if (!value) value = old;
      if (await DeskWatch.secretSet({ key: k, value }).then(() => true, () => false)) localStorage.removeItem(k);
    }
    mem.set(k, value);
  }
}

export const secret = {
  get: (k: Key) => mem.get(k) ?? "",
  set(k: Key, value: string) {
    mem.set(k, value);
    if (!native) return value ? localStorage.setItem(k, value) : localStorage.removeItem(k);
    void DeskWatch.secretSet({ key: k, value }).catch(() => {});
  },
  clear: () => KEYS.forEach((k) => secret.set(k, "")),
};
