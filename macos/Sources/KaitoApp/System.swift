import AppKit
import Carbon.HIToolbox
import Foundation
import Security
import ServiceManagement
import UserNotifications

/// Token de Jira en el llavero de macOS (servicio "kaito-jira").
enum Keychain {
    static let service = "kaito-jira"
    static let account = "jira"

    private static func base() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func token() -> String? {
        var q = base()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    @discardableResult
    static func setToken(_ token: String) -> Bool {
        let data = Data(token.utf8)
        let status = SecItemUpdate(base() as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return true }
        var add = base()
        add[kSecValueData as String] = data
        add[kSecAttrLabel as String] = "Kaito Jira"
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func deleteToken() {
        SecItemDelete(base() as CFDictionary)
    }
}

/// Notificaciones del sistema (opcionales: si no hay permiso o bundle, no hace nada).
enum Notifier {
    static var available: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app" }

    static func setup() {
        guard available else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    static func post(title: String, body: String) {
        guard available else { return }
        let c = UNMutableNotificationContent()
        c.title = title
        c.body = body
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil)
        UNUserNotificationCenter.current().add(req) { _ in }
    }
}

/// Abrir al iniciar sesión (SMAppService, macOS 13+).
enum LoginItem {
    static var enabled: Bool { SMAppService.mainApp.status == .enabled }

    static func set(_ on: Bool) throws {
        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }
}

/// Atajo global con RegisterEventHotKey de Carbon (no necesita permiso de Accesibilidad).
final class HotKey {
    static let shared = HotKey()
    private var ref: EventHotKeyRef?
    private var handlerInstalled = false
    fileprivate static var action: (() -> Void)?

    static let labels: [String: String] = [
        "ctrl+alt+space": "⌃⌥Espacio",
        "ctrl+alt+k": "⌃⌥K",
        "ctrl+shift+space": "⌃⇧Espacio",
        "cmd+shift+k": "⇧⌘K",
        "off": "Desactivado",
    ]

    /// "ctrl+alt+space" → (keyCode, modificadores Carbon).
    static func parse(_ s: String) -> (UInt32, UInt32)? {
        var mods: UInt32 = 0
        var key: UInt32?
        for part in s.lowercased().split(separator: "+") {
            switch part {
            case "ctrl": mods |= UInt32(controlKey)
            case "alt", "opt", "option": mods |= UInt32(optionKey)
            case "cmd": mods |= UInt32(cmdKey)
            case "shift": mods |= UInt32(shiftKey)
            case "space": key = UInt32(kVK_Space)
            case "k": key = UInt32(kVK_ANSI_K)
            case "j": key = UInt32(kVK_ANSI_J)
            default: return nil
            }
        }
        guard let key, mods != 0 else { return nil }
        return (key, mods)
    }

    @discardableResult
    func register(_ spec: String, action: @escaping () -> Void) -> Bool {
        unregister()
        HotKey.action = action
        guard let parsed = HotKey.parse(spec) else { return false }
        let (code, mods) = parsed
        if !handlerInstalled {
            var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let status = InstallEventHandler(GetApplicationEventTarget(), { _, _, _ -> OSStatus in
                DispatchQueue.main.async { HotKey.action?() }
                return noErr
            }, 1, &type, nil, nil)
            handlerInstalled = status == noErr
        }
        let id = EventHotKeyID(signature: OSType(0x4B41_4954), id: 1) // 'KAIT'
        let status = RegisterEventHotKey(code, mods, id, GetApplicationEventTarget(), 0, &ref)
        if status != noErr { NSLog("kaito: no se pudo registrar el atajo \(spec) (\(status))") }
        return status == noErr
    }

    func unregister() {
        if let ref { UnregisterEventHotKey(ref) }
        ref = nil
    }
}
