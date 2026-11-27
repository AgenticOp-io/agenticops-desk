import { Capacitor, registerPlugin } from "@capacitor/core";

// Native side: android/.../DeskWatchPlugin.java and ios/App/App/DeskWatch.swift. Alerts while the app is closed, the system
// browser, and the vault (Android Keystore / iOS keychain).
export const DeskWatch = registerPlugin<{
  setup(o: { token: string; repos: string }): Promise<void>;
  stop(): Promise<void>;
  ask(): Promise<void>;
  open(o: { url: string }): Promise<void>;
  status(): Promise<{ enabled: boolean }>;
  secretGet(o: { key: string }): Promise<{ value: string }>;
  secretSet(o: { key: string; value: string }): Promise<void>;
  // key: PKCS#8, cert: X.509, both base64 DER: the phone's client certificate for the desk.
  cloud(o: { url: string; pin: string; token: string; key: string; cert: string; body?: string }): Promise<{ status: number; body: string }>;
}>("DeskWatch");
export const native = Capacitor.isNativePlatform();

// The GitHub token, the phone agent's API key, the cloud desk token and the desk's phone key (phone.sign, seals inbox
// messages). On the phone they live in the Keystore vault (Vault.java); a browser preview has no vault and keeps them in
// localStorage. Read once at start so getters stay sync.
const KEYS = ["gh.token", "phone.ai", "cloud.desk", "phone.sign"] as const;
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
