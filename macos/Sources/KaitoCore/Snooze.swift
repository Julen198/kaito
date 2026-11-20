import Foundation

/// Posponer recordatorios (port de snoozeUntil/snoozeLabel de quiet.js).
public enum SnoozeOption: Equatable, Sendable {
    case minutes(Int)
    /// 09:00 locales del día siguiente (si ahora son menos de las 06:00, las de hoy).
    case tomorrow

    /// Opciones del chevron de la tarjeta.
    public static let menu: [SnoozeOption] = [.minutes(15), .minutes(30), .minutes(60), .minutes(180), .tomorrow]

    public var label: String {
        switch self {
        case .tomorrow: return "Mañana 9:00"
        case .minutes(let m): return Snooze.label(m)
        }
    }
}

public enum Snooze {
    /// Valores permitidos de `snoozeMinutes` (config).
    public static let choices = [5, 10, 15, 30, 60]

    public static func minutesOr(_ v: Double?) -> Int {
        guard let v, v.isFinite, v.rounded() == v, choices.contains(Int(v)) else { return 10 }
        return Int(v)
    }

    /// 10 → "10 min", 60 → "1 h", 180 → "3 h".
    public static func label(_ min: Int) -> String { min % 60 == 0 ? "\(min / 60) h" : "\(min) min" }

    /// Hasta cuándo posponer. Los minutos son tiempo real (no los altera el cambio de hora).
    public static func until(_ option: SnoozeOption, now: Date, calendar cal: Calendar = .current) -> Date {
        switch option {
        case .minutes(let m): return now.addingTimeInterval(Double(m) * 60)
        case .tomorrow:
            let h = cal.component(.hour, from: now)
            return Quiet.atLocal(now, h < 6 ? 0 : 1, 9 * 60, cal)
        }
    }
}
