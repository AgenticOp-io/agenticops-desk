import BackgroundTasks
import Capacitor
import CryptoKit
import Security
import UIKit
import UserNotifications

// The iPhone side of mobile/secrets.ts's DeskWatch plugin; same methods as android/.../DeskWatchPlugin.java.
// Secrets live in the iOS keychain (this device only, readable after the first unlock so the background check works).

// Main.storyboard's view controller: registers the app's own plugin with the Capacitor bridge.
class DeskViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(DeskWatchPlugin())
    }
}

enum Keychain {
    static let service = "io.agenticop.desk.vault"

    static func get(_ key: String) -> String {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key,
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    @discardableResult
    static func set(_ key: String, _ value: String) -> Bool {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        SecItemDelete(base as CFDictionary)
        if value.isEmpty { return true }
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    // The keychain outlives an uninstall; a fresh install must not come back signed in.
    static func wipe() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
        SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: ClientIdentity.tag] as CFDictionary)
        SecItemDelete([kSecClass as String: kSecClassCertificate, kSecAttrLabel as String: ClientIdentity.label] as CFDictionary)
    }
}

// Background alerts: the same check as DeskWatchWorker.java. iOS decides when a background refresh runs (often hours apart,
// never after the user force-quits the app); there is no push server, so this is best effort.
enum DeskWatch {
    static let task = "io.agenticop.desk.watch"
    static let defaults = UserDefaults.standard

    static func register() {
        if !defaults.bool(forKey: "deskwatch.installed") {
            Keychain.wipe()
            defaults.set(true, forKey: "deskwatch.installed")
        }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: task, using: nil) { t in
            guard let t = t as? BGAppRefreshTask else { return t.setTaskCompleted(success: false) }
            schedule()
            let work = Task {
                await check()
                t.setTaskCompleted(success: true)
            }
            t.expirationHandler = { work.cancel() }
        }
        // The open app shows its own cards and finished chats; alerts start from when it leaves the screen.
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            if Keychain.get("watch.token").isEmpty { return }
            defaults.set(Date().timeIntervalSince1970 * 1000, forKey: "deskwatch.since")
            schedule()
        }
    }

    static func schedule() {
        if Keychain.get("watch.token").isEmpty { return }
        let r = BGAppRefreshTaskRequest(identifier: task)
        r.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(r)
    }

    static func check() async {
        let token = Keychain.get("watch.token")
        if token.isEmpty { return }
        let now = Date().timeIntervalSince1970 * 1000
        let since = defaults.object(forKey: "deskwatch.since") as? Double ?? now
        for repo in (defaults.string(forKey: "deskwatch.repos") ?? "").split(separator: " ").map(String.init) {
            if !matches(repo, #"^[\w.-]+/[\w.-]+$"#) { continue }
            do {
                let (code, refData) = try await get(token, "/repos/\(repo)/git/ref/heads/desk-chats", raw: false)
                if code == 401 { // signed out on github.com; stop until the app signs in again
                    Keychain.set("watch.token", "")
                    return
                }
                guard code == 200,
                      let ref = (try? JSONSerialization.jsonObject(with: refData)) as? [String: Any],
                      let head = (ref["object"] as? [String: Any])?["sha"] as? String else { continue }
                if head == defaults.string(forKey: "deskwatch.head:\(repo)") { continue }
                let (_, treeData) = try await get(token, "/repos/\(repo)/git/trees/\(head)?recursive=1", raw: false)
                let tree = ((try? JSONSerialization.jsonObject(with: treeData)) as? [String: Any])?["tree"] as? [[String: Any]] ?? []
                let seen = Set(defaults.stringArray(forKey: "deskwatch.seen:\(repo)") ?? [])
                var open: [String] = []
                var finished = Set<String>()
                for item in tree {
                    guard let path = item["path"] as? String else { continue }
                    if matches(path, #"^approvals/[\w.-]+\.json$"#) {
                        let data = try await file(token, repo, path)
                        for a in (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] ?? [] {
                            let request = a["request"] as? String ?? ""
                            open.append(request)
                            if !seen.contains(request) { notify("Needs your answer", a["summary"] as? String ?? "", id: "a:\(request)") }
                        }
                    } else if matches(path, #"^jobs/[\w.-]+\.jsonl$"#) {
                        let text = String(decoding: try await file(token, repo, path), as: UTF8.self)
                        for line in text.split(separator: "\n") {
                            guard let j = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else { continue } // a half-written line
                            if j["ev"] as? String == "end", let at = (j["at"] as? NSNumber)?.doubleValue, at > since, let chat = j["chat"] as? String {
                                finished.insert(chat)
                            }
                        }
                    }
                }
                if !finished.isEmpty {
                    let data = try await file(token, repo, "chats.json")
                    let chats = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] ?? []
                    for chat in finished {
                        let title = chats.first(where: { $0["id"] as? String == chat })?["title"] as? String ?? ""
                        notify("Chat finished", title.isEmpty ? "Untitled chat" : title, id: "f:\(chat)")
                    }
                }
                defaults.set(head, forKey: "deskwatch.head:\(repo)")
                defaults.set(open, forKey: "deskwatch.seen:\(repo)")
            } catch {
                return // keep the repos already read, so their alerts don't repeat; try again next time
            }
        }
        defaults.set(now, forKey: "deskwatch.since")
    }

    static func matches(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }

    static func notify(_ title: String, _ body: String, id: String) {
        let c = UNMutableNotificationContent()
        c.title = title
        c.body = body
        c.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
    }

    static func get(_ token: String, _ path: String, raw: Bool) async throws -> (Int, Data) {
        guard let url = URL(string: "https://api.github.com" + path) else { return (0, Data()) }
        var r = URLRequest(url: url)
        r.timeoutInterval = 30
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.setValue(raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", forHTTPHeaderField: "Accept")
        let (data, res) = try await URLSession.shared.data(for: r)
        return ((res as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    static func file(_ token: String, _ repo: String, _ path: String) async throws -> Data {
        let (code, data) = try await get(token, "/repos/\(repo)/contents/\(path)?ref=desk-chats", raw: true)
        return code == 200 ? data : Data()
    }
}

// The phone's client certificate for the superadmin desk (key: PKCS#8, cert: X.509, both base64 DER, from the pairing QR).
// iOS only builds a TLS identity from a key and a certificate stored together in the keychain.
enum ClientIdentity {
    static let tag = Data("io.agenticop.desk.client".utf8)
    static let label = "AgenticOps desk client"
    private static var cached: (String, SecIdentity)?

    static func make(keyB64: String, certB64: String) throws -> SecIdentity {
        if let c = cached, c.0 == keyB64 + certB64 { return c.1 }
        guard let keyDer = Data(base64Encoded: keyB64), let certDer = Data(base64Encoded: certB64),
              let cert = SecCertificateCreateWithData(nil, certDer as CFData) else { throw fail("The phone's certificate is damaged.") }
        // A P-256 PKCS#8 key from Node: the private scalar follows 02 01 01 04 20, the public point is the last 65 bytes.
        let b = [UInt8](keyDer)
        let marker: [UInt8] = [0x02, 0x01, 0x01, 0x04, 0x20]
        guard b.count > 70, let at = (0...(b.count - marker.count)).first(where: { Array(b[$0..<($0 + 5)]) == marker }),
              at + 37 <= b.count, b[b.count - 65] == 0x04 else { throw fail("The phone's key is not a P-256 key.") }
        let x963 = Data(b[(b.count - 65)...]) + Data(b[(at + 5)..<(at + 37)])
        var error: Unmanaged<CFError>?
        let attrs: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass as String: kSecAttrKeyClassPrivate]
        guard let key = SecKeyCreateWithData(x963 as CFData, attrs as CFDictionary, &error) else {
            throw error?.takeRetainedValue() as Error? ?? fail("The phone's key did not load.")
        }
        SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag] as CFDictionary)
        SecItemDelete([kSecClass as String: kSecClassCertificate, kSecAttrLabel as String: label] as CFDictionary)
        let addKey = SecItemAdd([kSecClass as String: kSecClassKey, kSecValueRef as String: key, kSecAttrApplicationTag as String: tag,
                                 kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly] as CFDictionary, nil)
        let addCert = SecItemAdd([kSecClass as String: kSecClassCertificate, kSecValueRef as String: cert, kSecAttrLabel as String: label] as CFDictionary, nil)
        guard addKey == errSecSuccess || addKey == errSecDuplicateItem, addCert == errSecSuccess || addCert == errSecDuplicateItem else {
            throw fail("The keychain refused the phone's certificate (\(addKey), \(addCert)).")
        }
        var out: CFTypeRef?
        let q: [String: Any] = [kSecClass as String: kSecClassIdentity, kSecReturnRef as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let found = out, CFGetTypeID(found) == SecIdentityGetTypeID() else {
            throw fail("The keychain did not pair the phone's key with its certificate.")
        }
        let identity = found as! SecIdentity
        cached = (keyB64 + certB64, identity)
        return identity
    }

    static func fail(_ m: String) -> NSError { NSError(domain: "DeskWatch", code: 1, userInfo: [NSLocalizedDescriptionKey: m]) }
}

// Trusts exactly one key: the sha256 public-key pin the desk put in the pairing QR (the desk's certificate is self-signed and
// its address may change), and answers the desk's certificate request with the phone's own certificate.
final class PinnedDesk: NSObject, URLSessionDelegate {
    // DER SubjectPublicKeyInfo header for an EC P-256 key; the desk's key is always P-256 (fleetCore.ts).
    static let p256Spki = Data([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00])
    let pin: Data
    let identity: SecIdentity

    init(pin: Data, identity: SecIdentity) {
        self.pin = pin
        self.identity = identity
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        if space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = space.serverTrust {
            let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate] ?? []
            guard let leaf = chain.first, let key = SecCertificateCopyKey(leaf),
                  let raw = SecKeyCopyExternalRepresentation(key, nil) as Data?, raw.count == 65,
                  Data(SHA256.hash(data: PinnedDesk.p256Spki + raw)) == pin else {
                return completionHandler(.cancelAuthenticationChallenge, nil)
            }
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else if space.authenticationMethod == NSURLAuthenticationMethodClientCertificate {
            completionHandler(.useCredential, URLCredential(identity: identity, certificates: nil, persistence: .forSession))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
}

@objc(DeskWatchPlugin)
public class DeskWatchPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DeskWatchPlugin"
    public let jsName = "DeskWatch"
    public let pluginMethods: [CAPPluginMethod] = ["secretGet", "secretSet", "setup", "stop", "status", "ask", "open", "cloud"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    // The app's own secrets get an "app." prefix so they never collide with the watcher's copy of the token.
    @objc func secretGet(_ call: CAPPluginCall) {
        call.resolve(["value": Keychain.get("app." + (call.getString("key") ?? ""))])
    }

    @objc func secretSet(_ call: CAPPluginCall) {
        if Keychain.set("app." + (call.getString("key") ?? ""), call.getString("value") ?? "") { call.resolve() } else { call.reject("Could not store the secret") }
    }

    @objc func setup(_ call: CAPPluginCall) {
        let fresh = Keychain.get("watch.token").isEmpty
        guard Keychain.set("watch.token", call.getString("token") ?? "") else { return call.reject("Could not store the token") }
        DeskWatch.defaults.set(call.getString("repos") ?? "", forKey: "deskwatch.repos")
        if fresh { DeskWatch.defaults.set(Date().timeIntervalSince1970 * 1000, forKey: "deskwatch.since") } // no alerts for chats that ended before
        DeskWatch.schedule()
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        Keychain.set("watch.token", "")
        for k in DeskWatch.defaults.dictionaryRepresentation().keys where k.hasPrefix("deskwatch.") && k != "deskwatch.installed" {
            DeskWatch.defaults.removeObject(forKey: k)
        }
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: DeskWatch.task)
        call.resolve()
    }

    @objc func status(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { s in
            call.resolve(["enabled": s.authorizationStatus == .authorized || s.authorizationStatus == .provisional])
        }
    }

    @objc func ask(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in call.resolve() }
    }

    // External links go to Safari; navigating the WebView would replace the app with a web page.
    @objc func open(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), s.hasPrefix("https://"), let url = URL(string: s) else { return call.reject("https only") }
        DispatchQueue.main.async {
            UIApplication.shared.open(url)
            call.resolve()
        }
    }

    // A cloud-agent call to the superadmin desk, like DeskWatchPlugin.cloud on Android.
    @objc func cloud(_ call: CAPPluginCall) {
        let url = call.getString("url") ?? "", pin = call.getString("pin") ?? "", token = call.getString("token") ?? ""
        guard url.hasPrefix("https://"), let target = URL(string: url), let want = Data(base64Encoded: pin) else {
            return call.reject("https, a pin and a client certificate only")
        }
        let identity: SecIdentity
        do {
            identity = try ClientIdentity.make(keyB64: call.getString("key") ?? "", certB64: call.getString("cert") ?? "")
        } catch {
            return call.reject("Could not load the phone's certificate: \(error.localizedDescription)")
        }
        let session = URLSession(configuration: .ephemeral, delegate: PinnedDesk(pin: want, identity: identity), delegateQueue: nil)
        var r = URLRequest(url: target)
        r.timeoutInterval = 30
        r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        r.setValue("application/json", forHTTPHeaderField: "content-type")
        if let body = call.getString("body") {
            r.httpMethod = "POST"
            r.httpBody = Data(body.utf8)
        }
        session.dataTask(with: r) { data, res, err in
            session.finishTasksAndInvalidate()
            if let err = err { return call.reject("Could not reach the desk: \(err.localizedDescription)") }
            call.resolve(["status": (res as? HTTPURLResponse)?.statusCode ?? 0, "body": String(decoding: data ?? Data(), as: UTF8.self)])
        }.resume()
    }
}
