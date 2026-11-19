import XCTest
@testable import KaitoCore

final class TerminalScriptsTests: XCTestCase {
    func testQuoteAndTty() {
        XCTAssertEqual(TerminalScripts.quote("a \"b\" \\c"), "\"a \\\"b\\\" \\\\c\"")
        XCTAssertEqual(TerminalScripts.ttyPath("ttys003\n"), "/dev/ttys003")
        XCTAssertNil(TerminalScripts.ttyPath("??"))
        XCTAssertNil(TerminalScripts.ttyPath(""))
        XCTAssertEqual(TerminalScripts.ttyPath("/dev/ttys001"), "/dev/ttys001")
    }

    func testScripts() {
        let f = TerminalScripts.focusTerminal(tty: "/dev/ttys003")
        XCTAssertTrue(f.contains("tell application id \"com.apple.Terminal\""))
        XCTAssertTrue(f.contains("if tty of t is \"/dev/ttys003\" then"))
        XCTAssertTrue(TerminalScripts.focusITerm(tty: "/dev/ttys004").contains("if tty of s is \"/dev/ttys004\" then"))
        let cmd = TerminalScripts.claudeLaunchCommand(repo: "/Users/a/my repo", promptPath: "/Users/a/.cache/kaito/prompts/RUN-1.txt")
        XCTAssertEqual(cmd, "cd '/Users/a/my repo' && claude \"$(cat '/Users/a/.cache/kaito/prompts/RUN-1.txt')\"")
        XCTAssertTrue(TerminalScripts.runInTerminal(cmd).contains("do script \"cd '/Users/a/my repo' && claude \\\"$(cat '/Users/a/.cache/kaito/prompts/RUN-1.txt')\\\"\""))
        XCTAssertTrue(TerminalScripts.runInITerm(cmd).contains("write text \"cd "))
        XCTAssertEqual(TerminalScripts.resolve("auto", itermRunning: true), "iterm")
        XCTAssertEqual(TerminalScripts.resolve("auto", itermRunning: false), "terminal")
        XCTAssertEqual(TerminalScripts.resolve("warp", itermRunning: true), "warp")
        XCTAssertEqual(TerminalScripts.resolve("ptyxis", itermRunning: false), "terminal")
    }
}
