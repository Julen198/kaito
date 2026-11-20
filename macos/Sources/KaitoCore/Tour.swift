import Foundation

public struct TourBullet: Equatable, Sendable {
    /// blue | green | orange | purple
    public let tone: String
    public let bold: String
    public let text: String
}

public struct TourStep: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let text: String
    public let bullets: [TourBullet]
}

/// Tour de bienvenida: pasos por zona del menú, en el orden de la maqueta, saltando las zonas que no se muestran.
public enum Tour {
    public static let welcomeTitle = "Kaito ya está en tu barra"
    public static let welcomeText = "Tus agentes, tickets, pendientes, recordatorios y notas en un solo menú. Te enseñamos para qué sirve cada zona y qué puedes hacer en ella; son un par de minutos."
    public static let doneMessage = "Listo. Puedes repetir el tour desde Ajustes."

    static func b(_ tone: String, _ bold: String, _ text: String) -> TourBullet { TourBullet(tone: tone, bold: bold, text: text) }

    public static let all: [TourStep] = [
        TourStep(id: "usage", title: "Uso de tus IAs",
                 text: "Un anillo por cada herramienta que tienes instalada: Claude, Codex, OpenCode o Gemini.",
                 bullets: [b("blue", "Anillo lleno:", "cuánto llevas gastado del límite de 5 horas y de la semana."),
                           b("orange", "Naranja o rojo:", "te queda poco; mejor deja lo pesado para luego."),
                           b("purple", "A la derecha", "ves a qué hora se reinicia el límite («reinicia 14:50»).")]),
        TourStep(id: "agents", title: "Agentes",
                 text: "Cada sesión de Claude Code, Codex u otro agente que tengas abierta, en el repo donde trabaja.",
                 bullets: [b("green", "Verde que parpadea:", "está trabajando. No tienes que mirar la terminal."),
                           b("orange", "Naranja:", "te pide permiso o te pregunta algo. Respóndele desde aquí sin cambiar de ventana."),
                           b("blue", "Púlsalo", "para saltar a su pestaña de la terminal."),
                           b("purple", "Al terminar", "deja commit y push en la rama del ticket, te avisa en pantalla y crea un recordatorio para revisarlo.")]),
        TourStep(id: "board", title: "Tus tickets de Jira",
                 text: "Ordenados por estado y prioridad, con las mismas flechas que en Jira.",
                 bullets: [b("blue", "Pestañas:", "Mías, Sin asignar (con «Asignarme»), Sprint y Recientes."),
                           b("green", "▶ Mandar a Claude:", "eliges el repo y Claude empieza con todo el contexto del ticket. Si ya hay una rama del ticket, sigue en ella."),
                           b("orange", "La flecha", "despliega el ticket completo; desde ahí cambias su estado o lo abres en Jira.")]),
        TourStep(id: "todos", title: "Pendientes", text: "Una lista de cosas por hacer, sin fecha.",
                 bullets: [b("green", "Márcalas", "cuando las acabes y desaparecen."),
                           b("blue", "Para cosas con hora,", "mejor un recordatorio.")]),
        TourStep(id: "reminders", title: "Recordatorios", text: "Te avisan con una tarjeta en pantalla a la hora que digas.",
                 bullets: [b("blue", "Escríbelos normal:", "«llamar a Iker en 20 min», «revisar deploy el lunes a las 10»."),
                           b("orange", "Posponer:", "15 min, 30 min, 1 h, 3 h o mañana a las 9."),
                           b("purple", "Con No molestar", "activo o fuera de tu horario, se guardan y te llegan después.")]),
        TourStep(id: "tasks", title: "Tareas programadas",
                 text: "Claude hace una revisión por su cuenta cada cierto tiempo y te avisa del resultado.",
                 bullets: [b("blue", "Ejemplo:", "«cada lunes a las 9 revisa en BigQuery las ventas de la semana»."),
                           b("green", "Solo lectura:", "puede consultar, nunca cambiar nada."),
                           b("orange", "Ligadas a un ticket:", "útil para comprobar unos días después que un cambio funciona.")]),
        TourStep(id: "notes", title: "Notas", text: "Para apuntar algo rápido sin abrir otra aplicación.",
                 bullets: [b("blue", "Se quedan aquí", "hasta que las borres."),
                           b("green", "Desde cualquier sitio:", "Ctrl+Alt+Espacio y escribes.")]),
        TourStep(id: "create", title: "Crear desde cualquier sitio",
                 text: "Ctrl+Alt+Espacio abre una caja encima de lo que estés haciendo.",
                 bullets: [b("blue", "Cuatro pestañas:", "Nota, Recordatorio, Jira y Tarea."),
                           b("green", "En Jira", "describes el problema con tus palabras y la IA redacta el ticket por ti."),
                           b("orange", "Los ejemplos de fondo", "te enseñan cómo escribir cada cosa.")]),
        TourStep(id: "settings", title: "Ajustes", text: "Para dejar Kaito a tu manera.",
                 bullets: [b("blue", "Encender o apagar:", "Jira, el tablero, el panel de notificaciones y cada agente detectado."),
                           b("orange", "No molestar:", "pon tu horario de trabajo y fuera de él Kaito se calla."),
                           b("purple", "Repetir este tour", "cuando quieras.")]),
    ]

    /// Pasos aplicables. "Tu tablero" (sin Jira) no existe en Mac: sin Jira se salta ese paso.
    public static func steps(jira: Bool, usage: Bool, tasks: Bool) -> [TourStep] {
        all.filter { s in
            switch s.id {
            case "usage": return usage
            case "board": return jira
            case "tasks": return tasks
            default: return true
            }
        }
    }

    /// Debe arrancar al abrir el popover: solo si aún no se ha visto.
    public static func shouldStart(_ cfg: KaitoConfig) -> Bool { !cfg.tourDone }

    /// Id de la zona resaltada en el popover (crear y ajustes comparten el pie).
    public static func anchor(_ stepId: String) -> String {
        stepId == "create" || stepId == "settings" ? "footer" : stepId
    }
}
