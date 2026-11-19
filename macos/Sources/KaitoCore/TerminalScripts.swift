import Foundation

/// AppleScript para enfocar la pestaña de un agente y abrir Claude en una terminal (texto puro; lo ejecuta KaitoApp).
public enum TerminalScripts {
    public static let terminalBundle = "com.apple.Terminal"
    public static let itermBundle = "com.googlecode.iterm2"
    public static let warpBundle = "dev.warp.Warp-Stable"

    /// Literal de cadena AppleScript (con comillas).
    public static func quote(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// Salida de `ps -o tty= -p PID` ("ttys003", "??") → "/dev/ttys003" o nil.
    public static func ttyPath(_ psOut: String) -> String? {
        let t = trimmed(psOut)
        guard !t.isEmpty, !t.hasPrefix("?"), t != "-" else { return nil }
        return t.hasPrefix("/dev/") ? t : "/dev/\(t)"
    }

    /// Terminal.app: selecciona la pestaña cuyo tty coincide y trae su ventana al frente. Devuelve "ok" o "no".
    public static func focusTerminal(tty: String) -> String {
        """
        tell application id "\(terminalBundle)"
            repeat with w in windows
                repeat with t in tabs of w
                    if tty of t is \(quote(tty)) then
                        set selected tab of w to t
                        set index of w to 1
                        activate
                        return "ok"
                    end if
                end repeat
            end repeat
        end tell
        return "no"
        """
    }

    /// iTerm2: selecciona ventana, pestaña y sesión con ese tty.
    public static func focusITerm(tty: String) -> String {
        """
        tell application id "\(itermBundle)"
            repeat with w in windows
                repeat with t in tabs of w
                    repeat with s in sessions of t
                        if tty of s is \(quote(tty)) then
                            select w
                            tell t to select
                            tell s to select
                            activate
                            return "ok"
                        end if
                    end repeat
                end repeat
            end repeat
        end tell
        return "no"
        """
    }

    /// Terminal.app: ejecuta el comando en una ventana nueva.
    public static func runInTerminal(_ command: String) -> String {
        """
        tell application id "\(terminalBundle)"
            activate
            do script \(quote(command))
        end tell
        """
    }

    /// iTerm2: pestaña nueva en la ventana actual (o ventana nueva) y escribe el comando.
    public static func runInITerm(_ command: String) -> String {
        """
        tell application id "\(itermBundle)"
            activate
            if (count of windows) is 0 then
                create window with default profile
            else
                tell current window to create tab with default profile
            end if
            tell current session of current window to write text \(quote(command))
        end tell
        """
    }

    /// Comando de shell que abre Claude en el repo con el prompt del fichero (el texto del ticket nunca va en argv).
    public static func claudeLaunchCommand(repo: String, promptPath: String) -> String {
        "cd \(shQuote(repo)) && \(JiraViews.claudeCommand(promptPath: promptPath))"
    }

    /// 'auto' → iTerm2 si está abierto; si no, Terminal. El resto tal cual.
    public static func resolve(_ preference: String, itermRunning: Bool) -> String {
        switch preference {
        case "terminal", "iterm", "warp": return preference
        default: return itermRunning ? "iterm" : "terminal"
        }
    }
}
