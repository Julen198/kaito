import XCTest
@testable import KaitoCore

/// Mismos casos que when.test.js (parseWhen y shortLabel).
final class WhenTests: XCTestCase {
    let cal = Calendar.current

    func date(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 0, _ mi: Int = 0) -> Date {
        cal.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: mi))!
    }

    /// miércoles 18 nov 2026, 13:40
    var now: Date { date(2026, 11, 18, 13, 40) }

    func iso(_ d: Date) -> String {
        let c = cal.dateComponents([.year, .month, .day, .hour, .minute], from: d)
        return "\(c.year!)-\(c.month!)-\(c.day!) \(c.hour!):\(String(format: "%02d", c.minute!))"
    }

    func t(_ txt: String, _ when: String, _ clean: String, _ label: String? = nil, file: StaticString = #filePath, line: UInt = #line) {
        guard let r = When.parse(txt, now: now, calendar: cal) else {
            return XCTFail("sin resultado: \(txt)", file: file, line: line)
        }
        XCTAssertEqual(iso(r.date), when, "fecha: \(txt)", file: file, line: line)
        XCTAssertEqual(r.clean, clean, "clean: \(txt)", file: file, line: line)
        if let label { XCTAssertEqual(r.label, label, "label: \(txt)", file: file, line: line) }
    }

    func testParseWhen() {
        t("llamar a Iker en 20 min", "2026-11-18 14:00", "llamar a Iker", "Hoy a las 14:00 (en 20 min)")
        t("en 2 horas comer", "2026-11-18 15:40", "comer")
        t("en media hora café", "2026-11-18 14:10", "café")
        t("en 1 h estirar", "2026-11-18 14:40", "estirar")
        t("Revisar PR mañana a las 9", "2026-11-19 9:00", "Revisar PR", "Mañana a las 09:00")
        t("mañana", "2026-11-19 9:00", "")
        t("pasado mañana a las 18:30 cena", "2026-11-20 18:30", "cena", "Pasado mañana a las 18:30")
        t("standup a las 17:30", "2026-11-18 17:30", "standup", "Hoy a las 17:30 (en 3 h 50 min)")
        t("gimnasio a las 9", "2026-11-19 9:00", "gimnasio") // ya pasó: mañana
        t("hoy a las 20 sacar basura", "2026-11-18 20:00", "sacar basura")
        t("a las 5 y media pan", "2026-11-19 5:30", "pan")
        t("reunión el lunes a las 10", "2026-11-23 10:00", "reunión", "Lunes 23 a las 10:00")
        t("lunes", "2026-11-23 9:00", "")
        t("el miércoles a las 15 dentista", "2026-11-18 15:00", "dentista")
        t("el miércoles a las 9 dentista", "2026-11-25 9:00", "dentista")
        t("a las 9 de la noche peli", "2026-11-18 21:00", "peli")
        t("a las 3 de la tarde", "2026-11-18 15:00", "")
        t("a las 10 menos cuarto", "2026-11-19 9:45", "")
    }

    func testParseWhenNil() {
        XCTAssertNil(When.parse("comprar leche", now: now, calendar: cal))
        XCTAssertNil(When.parse("hoy sin hora", now: now, calendar: cal))
        XCTAssertNil(When.parse("a las 25", now: now, calendar: cal))
        XCTAssertNil(When.parse("", now: now, calendar: cal))
    }

    func testShortLabel() {
        XCTAssertEqual(When.shortLabel(date(2026, 11, 18, 17, 30), now: now, calendar: cal), "hoy 17:30")
        XCTAssertEqual(When.shortLabel(date(2026, 11, 19, 9, 0), now: now, calendar: cal), "mañana 09:00")
        XCTAssertEqual(When.shortLabel(date(2026, 11, 23, 10, 0), now: now, calendar: cal), "lun 23 10:00")
        XCTAssertEqual(When.shortLabel(date(2026, 11, 17, 10, 0), now: now, calendar: cal), "vencido 10:00")
    }
}
