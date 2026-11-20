# Kaito

Kaito reúne en la barra del sistema tus agentes de Claude Code, tus tickets de Jira, pendientes,
notas, recordatorios y tareas programadas de Claude.

| Plataforma | Estado |
|---|---|
| Linux con GNOME (extensión de GNOME Shell) | Disponible |
| macOS 14+ (app de barra de menús, Apple Silicon e Intel) | Primera versión ([ver abajo](#macos)) |

## Instalar

| Entorno | Comando (en una terminal) |
|---|---|
| **Linux** con GNOME 46–50 (Ubuntu 24.04+, Debian 13, Fedora 40+) | `curl -fsSL https://raw.githubusercontent.com/Julen198/kaito/main/bootstrap.sh \| bash` |
| **macOS** 14 o posterior (Apple Silicon e Intel) | `curl -fsSL https://raw.githubusercontent.com/Julen198/kaito/main/macos/install-mac.sh \| bash` |

En los dos: después actualizas con `kaito update` (o el botón del menú) y lo quitas con `kaito uninstall`.
Luego abre **Kaito → Ajustes** para poner tu Jira (URL, email y token) o desactivarlo.

### Linux

Instalación en una línea:

```sh
curl -fsSL https://raw.githubusercontent.com/Julen198/kaito/main/bootstrap.sh | bash
# con flags: curl -fsSL https://raw.githubusercontent.com/Julen198/kaito/main/bootstrap.sh | bash -s -- --yes
```

O, si prefieres clonar a mano:

```sh
git clone https://github.com/Julen198/kaito.git ~/.local/share/kaito-src && ~/.local/share/kaito-src/bootstrap.sh
```

Variables: `KAITO_REPO`, `KAITO_BRANCH` (main), `KAITO_HOME` (`~/.local/share/kaito-src`).
El bootstrap clona, ejecuta `install.sh` y deja el comando `kaito` en `~/.local/bin`.

- **Actualizar:** `kaito update` (`--yes` sin preguntas; `--force` guarda cambios locales con stash).
  Se recarga en caliente, sin cerrar sesión. Con "Buscar actualizaciones" activo (Ajustes > General),
  el menú avisa arriba ("Hay una versión nueva (x.y.z) · Actualizar") y el botón hace lo mismo.
- **Recargar el código:** `kaito reload` (útil al desarrollar: aplica los cambios de `*.js` y `stylesheet.css`).
- **Diagnóstico:** `kaito doctor`. También `kaito version` y `kaito check [--json]`.
- **Tablero de tareas:** `kaito kanban` lo abre (opcional; ver [Tablero de tareas](#tablero-de-tareas)). `kaito doctor` dice si el tablero y el panel de avisos están activados.
- **Desinstalar:** `kaito uninstall` (`--purge` borra también el código y los datos).

### Publicar una versión

Sube el número en `VERSION` (semver, p. ej. `0.2.0`), haz commit en `main` y etiqueta `git tag v0.2.0 && git push --tags`.
`kaito update` detecta cualquier commit nuevo en la rama; `VERSION` es lo que se muestra al usuario.
La etiqueta `v*` lanza además `.github/workflows/macos.yml`, que compila la app universal de macOS y sube
`Kaito-macOS.zip` a la release de GitHub (la etiqueta debe coincidir con `VERSION`).

## macOS

Kaito para macOS es una app de barra de menús (SwiftUI, macOS 14 Sonoma o posterior, Apple Silicon e Intel)
que usa los mismos ficheros que la versión de Linux: `~/.config/kaito/{config,todos,notes,reminders}.json`,
los estados de los hooks en `~/.cache/kaito/state/` y los prompts en `~/.cache/kaito/prompts/`.

```sh
curl -fsSL https://raw.githubusercontent.com/Julen198/kaito/main/macos/install-mac.sh | bash
```

El instalador descarga `Kaito-macOS.zip` de la última release, lo deja en `~/Applications/Kaito.app`, quita la
cuarentena (`xattr -dr com.apple.quarantine`), descarga el código de esa release en `~/.local/share/kaito-src`
para instalar los hooks de Claude Code en `~/.claude/settings.json` (con `hooks/merge-settings.py`, igual que en
Linux; pregunta antes y hace copia) y abre la app. Opciones: `--yes`, `--no-hooks`, `--version vX.Y.Z`.

- **Actualizar:** `kaito update` (el instalador deja un comando `kaito` en `~/.local/bin` con `update`, `version`
  y `uninstall`) o, cuando hay versión nueva, el botón **Actualizar** del menú (mira GitHub como mucho cada 6 h).
- **Qué hace:** icono con contadores (agentes trabajando o que te necesitan · tickets de Jira · pendientes);
  secciones Agentes (Claude por su registro de sesiones y hooks; Codex, Gemini, Aider… por `ps`/`lsof`),
  Jira (pestañas Mías / Sin asignar / Sprint / Recientes, prioridad, cambiar estado, Asignarme, abrir en el
  navegador, **Mandar a Claude** con selector de repo), Pendientes, Recordatorios y Notas; Ajustes con el token
  en el llavero de macOS (servicio `kaito-jira`).
- **Ir a la terminal de un agente:** clic en la fila. En Terminal e iTerm2 se selecciona la pestaña exacta
  (por el `tty` del proceso); en Warp y otras se activa la app.
- **Mandar a Claude:** abre una ventana de Terminal o una pestaña de iTerm2 (`terminal` en Ajustes: automática,
  Terminal, iTerm2 o Warp, este con una launch configuration en `~/.warp/launch_configurations`).
- **Captura rápida:** ⌃⌥Espacio (configurable) abre un panel tipo Spotlight con Nota, Recordatorio (mismo
  lenguaje que en Linux: «llamar a Iker en 20 min», «mañana a las 9») y Jira (borrador con `claude -p` como en
  Linux; revisas y creas). Ojo: si tienes varias distribuciones de teclado, macOS usa ⌃⌥Espacio para cambiar
  de fuente de entrada; elige otro atajo en Ajustes.
- **Recordatorios:** tarjeta flotante arriba en el centro, en todos los escritorios, con sonido, «Posponer 10 min»
  y «Hecho».

Permisos que pedirá macOS:

- **Automatización** (Terminal / iTerm2), la primera vez que vas a la terminal de un agente o mandas un ticket a
  Claude. Si lo deniegas, se puede volver a dar en Ajustes del Sistema > Privacidad y seguridad > Automatización.
- **Notificaciones** (opcional): avisos de recordatorios y tickets creados.
- **Llavero:** tras cada actualización la app firmada ad hoc es «otra» para el llavero y puede preguntar si
  Kaito puede leer el token de Jira: responde «Permitir siempre».

Gatekeeper: la app no está notarizada (firma ad hoc). El instalador quita la cuarentena; si aun así macOS dice que
no se puede abrir, haz **clic derecho > Abrir** en `~/Applications/Kaito.app` la primera vez (o Ajustes del Sistema
> Privacidad y seguridad > «Abrir igualmente»).

Desarrollo: `macos/` es un paquete Swift (`KaitoCore`, solo Foundation y con tests; `KaitoApp`, la app).
`cd macos && swift test` (también en Linux: `podman run --rm -v "$PWD":/src:Z -w /src swift:6.0 swift test`) y
`./build-app.sh` (en un Mac con Xcode) genera `build/Kaito.app` y `build/Kaito-macOS.zip`.

## Requisitos

- GNOME Shell 46–50 en Wayland (ver la tabla). Con otra versión GNOME ignora la extensión
  (`shell-version` de `metadata.json`).
- `python3`, `glib-compile-schemas` (Fedora: `glib2-devel`; Ubuntu: `libglib2.0-bin`) y `gnome-extensions`.
- Opcionales: `secret-tool` (`libsecret` / `libsecret-tools`) y la CLI `claude` (borradores de Jira y agentes).

### Compatibilidad

| Distribución | GNOME Shell | Estado |
|---|---|---|
| Fedora 44 | 50 | Probado (sesión real) |
| Fedora 43 | 49 | Soportado (49 probado en Ubuntu 25.10) |
| Fedora 42 | 48 | Soportado (48 probado en Debian 13) |
| Fedora 41 | 47 | Soportado (47 inferido: sin imagen de prueba, APIs iguales a 46 y 48) |
| Fedora 40 | 46 | Soportado (46 probado en Ubuntu 24.04) |
| Ubuntu 26.04 LTS | 50 | Probado (contenedor, con ubuntu-dock, appindicator, tema Yaru y Ptyxis 50.1) |
| Ubuntu 25.10 | 49 | Probado (contenedor) |
| Ubuntu 25.04 | 48 | Soportado (48 probado en Debian 13; Ubuntu 25.04 ya sin soporte) |
| Ubuntu 24.04 LTS | 46 | Probado (contenedor) |
| Debian 13 (trixie) | 48 | Probado (contenedor) |
| Debian 12 (bookworm) | 43 | **No soportado** (GNOME 43 no tiene extensiones ESM) |

"Probado (contenedor)": `tests/compat/run.sh <46|48|49|50u|all>` arranca gnome-shell headless en podman,
comprueba que Kaito queda ACTIVE sin errores, ejecuta una autoprueba de la interfaz (menú, captura,
tarjetas, notificación, modales, recarga en caliente), los tests de GJS y carga las preferencias.

## Instalación manual

```sh
git clone https://github.com/Julen198/kaito.git ~/kaito && cd ~/kaito
./install.sh
```

`install.sh` (idempotente, se puede repetir sin miedo):

1. comprueba requisitos y compila los esquemas;
2. enlaza la carpeta en `~/.local/share/gnome-shell/extensions/kaito@runnea` (`--copy` para copiar);
3. fusiona los hooks de Claude Code en `~/.claude/settings.json` con la ruta de **tu** máquina, tras
   mostrar los cambios y pedir confirmación (copia de seguridad `settings.json.bak-kaito-<fecha>`;
   conserva tus claves y hooks);
4. habilita la extensión.

Opciones: `--dry-run` (no cambia nada), `--yes`, `--no-hooks`, `--statusline` / `--no-statusline`, `--copy`.

Después, la primera vez, **cierra sesión y vuelve a entrar** (Wayland no carga extensiones nuevas en caliente;
las actualizaciones posteriores se recargan solas, ver "Recarga en caliente").

### Configurar Jira

Abre el indicador de Kaito en la barra > **Ajustes** y rellena URL (`https://tuempresa.atlassian.net`),
email y API token (se crea en https://id.atlassian.com/manage-profile/security/api-tokens). El token se guarda
en el llavero del sistema (libsecret, `service=jira`); URL y email, en `~/.config/kaito/config.json`.
Sin `secret-tool`/Ajustes, a mano: `secret-tool store --label="Kaito Jira" service jira`.

### Claude Code: hooks y statusLine

Los hooks (`hooks/kaito-hook.py`) avisan a Kaito de lo que hacen tus agentes. `install.sh` los añade solo;
`hooks/settings-snippet.json` es la plantilla (con `__KAITO_HOOKS_DIR__`), no hace falta tocarla.
Para repetir solo esta parte: `./install.sh --yes` (o `python3 hooks/merge-settings.py install`). Los hooks
se leen al arrancar `claude`: reinicia las sesiones abiertas.

La statusLine (`hooks/kaito-statusline.py`, uso de 5 h / semanal) es opcional: `./install.sh --statusline`
(la pregunta también de forma interactiva, por defecto No). Si ya tienes una `statusLine`, no se pisa:
llama a `hooks/kaito-statusline.py` desde tu script (recibe el JSON por stdin).

### Desinstalar

```sh
./uninstall.sh            # deshabilita, borra el enlace y quita hooks/statusLine (con copia y confirmación)
./uninstall.sh --purge    # además borra ~/.config/kaito y ~/.cache/kaito
```

El token de Jira queda en el llavero: `secret-tool clear service jira`.

### Recarga en caliente (cómo funciona)

En Wayland gnome-shell cachea cada módulo ES por su URL durante toda la sesión, así que desactivar y
activar la extensión volvería a usar el código viejo. Por eso `extension.js` es solo un **cargador**:

- copia los `*.js` (menos `extension.js`, `prefs.js` y los tests) a `~/.cache/kaito/build/<hash>/` y
  hace `import()` de `main.js` desde ahí: cada versión, y todos sus imports relativos, tienen URL nueva;
- vigila `~/.cache/kaito/reload`: tocarlo (`kaito reload`, `kaito update`, botón "Actualizar") desactiva
  la versión en marcha, recarga `stylesheet.css` e importa la nueva; se guardan las 2 últimas builds;
- si la nueva no importa o falla al activarse, lo registra (`journalctl --user -b | grep kaito`),
  avisa con una notificación y vuelve a activar la anterior.

Los iconos, `bin/`, `hooks/`, `schemas/` y `stylesheet.css` se leen siempre de la carpeta real de la
extensión (nunca junto al módulo copiado). Las clases GObject llevan el hash de la build en su nombre
de tipo (`KaitoIndicator_<hash>`) porque GType no admite registrar dos veces el mismo nombre.

**Requiere cerrar sesión:** los cambios en `extension.js` (el cargador; mantenlo mínimo), en
`metadata.json` y en `schemas/`. `kaito update` lo avisa cuando pasa. `prefs.js` corre en otro proceso
y se recarga solo al reabrir Ajustes.

### Problemas frecuentes

- **No aparece en la barra**: cierra sesión y vuelve a entrar; `gnome-extensions list | grep kaito`;
  `gsettings get org.gnome.shell disable-user-extensions` debe ser `false`.
- **Errores**: `journalctl --user -b | grep -i kaito` (o `journalctl -f -o cat /usr/bin/gnome-shell`).
- **GNOME fuera de 46–50**: añade tu versión a `shell-version` en `metadata.json` (sin garantías;
  antes de 45 no funciona: Kaito usa módulos ES).
- **No salen agentes**: reinicia `claude` y comprueba que `~/.cache/kaito/state/` se llena.

### Privacidad

El token de Jira vive en el llavero, no en ficheros. Kaito solo habla con la API de Jira de tu empresa y con la
CLI local `claude`. Los hooks y las notas/pendientes se guardan en `~/.config/kaito` y `~/.cache/kaito`.
Nada se envía a terceros.

## Configuración de Jira (avanzado)

Equivale a lo que hace Ajustes: `~/.config/kaito/config.json`:

```json
{"jiraBaseUrl": "https://tuempresa.atlassian.net", "jiraEmail": "tu@email.com"}
```

## Ajustes

Menú del indicador > Ajustes (o `gnome-extensions prefs kaito@runnea`): conexión a Jira
(URL, email, token en el llavero, qué tickets mostrar con presets o JQL propia, máximo),
ventana de actividad de agentes, intervalo de refresco y borrado de pendientes hechos.
Se guardan en `config.json` (`jiraJql`, `jiraPreset`, `jiraMax`, `jiraView`, `jiraViews`, `jiraBuiltinViews`, `jiraProjects`, `terminal`, `agentWindowMinutes`,
`liveSeconds`, `refreshSeconds`, `notifyNeeds`, `notifyDone`, `dailySummary`, `pinned`, `showUsage`, `usagePanelProvider`,
`tasksEnabled`, `checkUpdates`, `jiraEnabled`, `workHours`, `dndManual`, `dndUntil`, `dndSkipUntil`,
`dndSilenceReminders`, `agentProviders`, `tourDone`). `repoRoots` (carpetas donde buscar repos) vale por defecto las que existan de
`~/Documentos`, `~/Documents`, `~/dev`, `~/code`, `~/projects` y `~/src`.

Tour de bienvenida: la primera vez que abres el menú (`tourDone` sin poner) sale una tarjeta para recorrer
cada zona del menú con una burbuja al lado ("Ahora no", "Saltar" o terminarlo lo marcan como visto; cerrar
el menú a medias lo deja pendiente). Ajustes > General > "Tour de bienvenida" > "Ver otra vez" lo vuelve a
sacar en la siguiente apertura. Textos y pasos en `tour.js` (`node tour.test.js`); burbuja en `tourui.js`.

`pinned` (Ajustes > General > "Mostrar siempre desplegado") deja un panel fijo arriba a la
derecha, por encima de las ventanas (se oculta en pantalla completa y en la vista de
actividades), con las mismas tres secciones que el menú.

### Jira opcional

Ajustes > Jira > **Usar Jira** (`jiraEnabled`, activado por defecto). Apagado, Kaito no habla con Jira: ni
descargas ni temporizadores de vistas; desaparecen la sección Jira y sus pestañas del menú (y de la tarjeta
fija), el contador de tickets del panel, la pestaña Jira de la captura y los botones que solo tienen sentido
con Jira (mandar a Claude, programar revisión, asignarme, cambiar estado, "Comentar en Jira" en avisos,
tarjetas de tareas y resultado de una tarea). El resumen de la mañana deja de contar tickets; al terminar un
agente con ticket se sigue mostrando la tarjeta con lo de git, pero el ticket no se mueve; las tareas
programadas con clave se ejecutan sin el contexto del ticket. La clave del ticket sigue viéndose como texto.
El cambio se aplica al momento (Kaito vigila `config.json`).

### Aviso de actualización

Si `kaito check --json` (cada 6 h; `checkUpdates`) encuentra commits nuevos, además de la fila del menú:

- una notificación **"Kaito <versión> disponible"** con hasta 3 líneas del changelog (asuntos de commit;
  `kaito check --json` devuelve `"changes": [...]`, hasta 5, de `git log --format=%s HEAD..@{u}`) y los
  botones **Actualizar** (lo mismo que el botón del menú) y **Más tarde**. Sale una vez por versión: la última
  avisada se guarda en `~/.cache/kaito/update.json`;
- un **punto azul** en el indicador del panel hasta que actualices (el nombre accesible dice "actualización
  disponible").

### Horario y No molestar

Kaito tiene su propio "No molestar" (no toca el de GNOME). Mientras dura no salen notificaciones de agentes
(te necesita / terminó), tarjetas de ticket listo ni de tareas programadas, el aviso de versión nueva ni
sonidos; el resumen de la mañana espera. Todo eso se guarda (en memoria y en
`~/.cache/kaito/quiet-queue.json`, máximo 30, sin duplicados) y al terminar sale **una** tarjeta
"Mientras no estabas" con la lista: cada línea con acción (ir al agente, ver la tarea, actualizar) es
clicable; "Entendido" la cierra. Las tareas programadas se siguen ejecutando. Los recordatorios salen igual
(sin sonido) salvo con **Silenciar también recordatorios** (`dndSilenceReminders`): entonces esperan a que
termine.

- Menú > **No molestar**: interruptor (sin límite) y **1 h**, **Hasta mañana** (hasta el próximo inicio de
  jornada) y **Desactivar**. Fuera de horario la fila dice p. ej. "Fuera de horario hasta lun 09:00" y
  "Desactivar" deja de silenciar hasta la próxima jornada (`dndSkipUntil`). Con silencio, el panel muestra
  una luna y se atenúa un poco.
- Ajustes > **Horario y No molestar**: "Usar horario de trabajo" (`workHours: {enabled, days: [1..7] (lunes
  = 1), start: "09:00", end: "18:00"}`; por defecto apagado, lunes a viernes de 9 a 18). Si el fin es
  anterior al inicio (22:00–06:00) el tramo acaba al día siguiente. Horas locales: los cambios de hora no
  descuadran.

### Agentes de Claude Code, Codex y otros

Kaito busca estas CLIs en el `PATH` y en `~/.local/bin`, `~/.npm-global/bin`, `~/.bun/bin`,
`~/.opencode/bin`, `~/.nvm/versions/node/*/bin`, `~/.cargo/bin` (la shell de GNOME no lee tu `~/.bashrc`):

| Proveedor | Integración |
|---|---|
| Claude Code (`claude`) | Completa: estado por hooks, "te necesita", Permitir/Denegar, ticket, tarjeta de ticket listo |
| Codex (`codex`) | Sesiones: trabajando/parado, última acción, aviso al terminar (≥ 3 min trabajando) |
| Gemini CLI, OpenCode, Aider, Cursor Agent | Básica: sesión abierta y su carpeta ("abierto") |

Los agentes que no son de Claude salen en la misma lista con una etiqueta del proveedor; se pueden ocultar
(×) y el clic lleva a su terminal (misma búsqueda de ventana por el árbol de procesos). Ajustes > **Agentes
detectados** activa o desactiva cada proveedor (`agentProviders: {"claude": true, "codex": true, …}`) y
muestra los que no están instalados atenuados. `kaito doctor` también los lista.

Cómo se ve una sesión de Codex (solo lectura, nunca se guarda el contenido de la conversación):

1. procesos `codex` vivos (`/proc/*/cmdline`; se ignoran `app-server`, `exec`, `mcp`… y el lanzador de node
   cuando el binario nativo es su hijo) y su carpeta (`/proc/<pid>/cwd`);
2. su rollout: el `~/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl` que el proceso tiene abierto
   (`/proc/<pid>/fd`) o, si no, el más reciente cuyo `session_meta.cwd` es esa carpeta;
3. estado: **trabajando** si el último `task_started` no tiene su `task_complete` (o, en rollouts sin turnos,
   si se modificó hace menos de `liveSeconds`); la última acción sale de la cola (orden, fichero editado o
   primera línea del último mensaje, recortadas).

**Aviso al terminar (opcional):** Codex puede ejecutar un programa al acabar cada turno (`notify`). Apúntalo
a `hooks/kaito-codex-notify.py`, que escribe `~/.cache/kaito/state/codex-<id>.json` con `"state": "done"` (y
solo la primera línea del último mensaje). En `~/.codex/config.toml`, **antes de la primera `[sección]`**:

```toml
notify = ["python3", "/ruta/a/kaito/hooks/kaito-codex-notify.py"]
```

`install.sh` lo ofrece (por defecto No; hace copia `config.toml.bak-kaito-*` e inserta solo esa línea) si
encuentras Codex y no tienes ya un `notify`; si tienes otro, no lo toca y te dice cómo encadenarlo.
`--no-codex` omite la pregunta. Sin el hook, el estado sale igualmente del rollout.

## Datos

- Agentes: `~/.claude/projects/*/*.jsonl` modificados en los últimos 10 min.
- Pendientes: `~/.config/kaito/todos.json` (`[{"text": "...", "done": false}]`); clic en un
  pendiente lo marca como hecho; el campo inferior añade uno nuevo con Enter.
- Se refresca cada 30 s y al abrir el menú.
- Agentes: punto que late si está trabajando; clic en la fila enfoca su ventana de terminal;
  `×` lo oculta (`~/.cache/kaito/dismissed.json`) hasta que tenga actividad nueva o te necesite.
- Jira: icono de prioridad delante de la clave; el botón de envío de cada ticket pide un repo
  (cwd de sesiones de Claude de los últimos 30 días) y abre Claude ahí con el ticket como prompt
  (`~/.cache/kaito/prompts/<KEY>.txt`). Terminal según `terminal` (Ajustes > General):
  - `auto` (por defecto, "Automático (recomendado)"): el primero disponible de Ptyxis (`ptyxis` o el
    flatpak `app.devsuite.Ptyxis`), GNOME Terminal, Consola (`kgx`) y Warp. Así los agentes lanzados desde
    Kaito se abren en pestañas de una terminal GNOME (tus propios agentes pueden seguir en Warp).
  - `ptyxis`: `ptyxis --tab -d <repo> -T <KEY> -- bash -lc 'claude "$(cat <prompt>)"'`.
  - `gnome-terminal`: `gnome-terminal --tab --working-directory=<repo> --title=<KEY> -- bash -lc …`.
  - `kgx`: `kgx --tab --working-directory=<repo> --title=<KEY> -- bash -lc …`.
  - `warp`: **pestaña nueva** en la ventana activa de Warp. Se escribe una Tab Config
    `~/.local/share/warp-terminal/tab_configs/kaito-<KEY>.toml` y se abre `warp://tab_config/kaito-<KEY>`
    (si no hay ventana de Warp, Warp abre una). Los `kaito-*.toml` de más de 10 min se borran.
  - `warp-window`: ventana nueva (modo antiguo, launch configuration `warp://launch/kaito-<KEY>.yaml`).

  El texto del ticket solo va en el fichero del prompt (nunca en argv). Un `terminal: "warp"` guardado por
  versiones anteriores se migra **una vez** a `auto` (queda `terminalMigrated: true`; si luego eliges Warp
  en Ajustes, se respeta). `kaito doctor` e `install.sh` dicen qué terminal elegiría `auto`.

  "Ir a la terminal" (clic en un agente) activa su ventana y, si se puede, **la pestaña exacta**:
  - Ptyxis: lee `PTYXIS_TAB` del entorno del agente (`/proc/<pid>/environ`, subiendo por los padres hasta
    la terminal) y llama a la acción `focus-tab-by-uuid` (`org.gtk.Actions` en `org.gnome.Ptyxis` o
    `app.devsuite.Ptyxis`). Ojo: Ptyxis solo exporta `PTYXIS_TAB` desde la versión 52; con Ptyxis 50/51
    se queda en la ventana.
  - GNOME Terminal: `GNOME_TERMINAL_SCREEN` → `ActivateResult` de su proveedor de búsqueda
    (`org.gnome.Terminal`, `/org/gnome/Terminal/SearchProvider`).
  - Warp, Consola y el resto: solo la ventana.

  El último repo por proyecto queda en `jiraRepoByProject`. Los tickets se ordenan: en curso,
  por hacer, bloqueados/esperando y resto, hechos; dentro, por prioridad y por actualización.
- Jira, vistas (pestañas bajo la cabecera "Jira"): **Mías** (la consulta de Ajustes; es la que cuenta el
  panel), **Sin asignar** (abiertos sin responsable en tus proyectos), **Sprint** (sprint activo de tus
  proyectos, con el responsable de cada fila; "No hay sprint activo" si el sitio no tiene sprints) y
  **Recientes** (tuyos, creados por ti o que sigues, actualizados en 24 h). Los proyectos salen de tus
  tickets ("Mías"; caché en `~/.cache/kaito/jira-projects.json`) o, si no hay, de `jiraProjects` en
  `config.json`. Cada vista se carga al elegirla y solo la activa (más "Mías") se refresca con el
  temporizador; la última queda en `jiraView`. "Asignarme" (en Sin asignar y en filas del sprint que no son
  tuyas) hace `PUT /rest/api/3/issue/<KEY>/assignee`. Ajustes > "Vistas de Jira": ocultar las integradas
  (`jiraBuiltinViews`) y vistas propias con nombre y JQL (`jiraViews: [{id, name, jql, enabled}]`).
- Pruebas: `node when.test.js` (con `TZ=Europe/Madrid` prueba también el cambio de hora), `gjs -m kaito.test.js`, `gjs -m jiradraft.test.js`,
  `XDG_CONFIG_HOME=$(mktemp -d) XDG_DATA_HOME=$(mktemp -d) gjs -m tasks.test.js`, `node quiet.test.js`, `node providers.test.js`,
  `node board.test.js` (tablero y panel de avisos), `node usage.test.js` (anillos de uso), `node tour.test.js` (tour)
  (también con `gjs -m`), `bash tests/cli.test.sh`, `hooks/kaito-hook.py --selftest`, `hooks/kaito-statusline.py --selftest`,
  `hooks/kaito-codex-notify.py --selftest`.

## Avisos de agentes

Los hooks de Claude Code escriben el estado de cada sesión en
`~/.cache/kaito/state/<session_id>.json` (respeta `XDG_CACHE_HOME`) y la extensión lo vigila.
Un agente que te necesita (permiso, pregunta, diálogo de elicitación) sale primero con la
etiqueta "Te necesita", el indicador de la barra se tiñe de naranja con su número, y, si
`notifyNeeds` está activo (Ajustes > Agentes), sale una notificación al entrar en ese estado.
Cuando un agente termina un turno aparece como "Terminó, esperando tu respuesta".

El script es `hooks/kaito-hook.py` (Python 3, solo biblioteca estándar; `--selftest` lo prueba).
Nunca falla con código distinto de 0 y solo escribe en stdout para responder a un permiso.

### Responder sin cambiar de ventana

Clic en un agente que "te necesita" (o en su notificación) abre un cuadro con su mensaje y,
si es un permiso, la herramienta y el comando. Con el hook `PermissionRequest` registrado,
**Permitir** / **Denegar** responden al permiso desde Kaito: el hook escribe la petición en el
estado y espera hasta 120 s a `~/.cache/kaito/decisions/<session_id>.json`. El diálogo de la
terminal sigue funcionando a la vez: si contestas allí, Claude Code corta el hook y gana tu
respuesta; si pasan los 120 s, los botones desaparecen y queda el diálogo de la terminal.
El texto libre no se puede inyectar como si lo escribieras tú (los mensajes entre sesiones de
Claude Code llegan como "de otra sesión" y no responden diálogos): Enter lo copia al
portapapeles y enfoca la terminal del agente para pegarlo con Ctrl+Shift+V.

### Al terminar un agente

Si un agente pasa de trabajar a parado tras 3 min o más (`notifyDone`), sale "<repo> terminó · N min"
con su último mensaje y las acciones **Ir al agente** y, si se lanzó desde un ticket,
**Comentar en Jira** (borrador con `claude -p` sin herramientas a partir del último mensaje,
`git log`/`git diff --stat` desde la rama base; editable, Enter publica, Esc descarta) y
**Mover a <estado>** (transición de revisión/pruebas, si existe).

### Tickets y agentes

Un agente lanzado con "Mandar a Claude" lleva su clave (se lee del primer mensaje del
transcript). En Jira, el ticket con agente vivo muestra el repo del agente en lugar del estado
(clic: su terminal). La flecha de cada ticket ("Cambiar estado") despliega sus transiciones.
Al mandar a Claude un ticket "Por hacer", pasa solo a la primera transición "en curso".
El prompt pide trabajar en una rama `<KEY>-…`, commits con prefijo `<KEY>: ` y, al terminar,
`git push -u origin <rama>` (nunca a main/master/develop, sin force-push, sin abrir PR).

### Ticket listo

Cuando un agente con ticket deja de trabajar (o el hook marca "done"), Kaito mira su repo con git
(sin shell): rama, commits desde que empezó a trabajar y si la rama está subida
(`@{u}` y `rev-list --count @{u}..HEAD`). Si hay commits nuevos (`autoReview`, por defecto activo):
1. Mueve el ticket con la transición de revisión/pruebas (`Probando`, `Revisión`, `Review`, `Test`);
   si no hay ninguna, no lo mueve y lo dice.
2. Muestra una tarjeta "<KEY> listo" arriba al centro (con sonido, no modal), con la rama
   (subida / sin subir), el estado en Jira y la primera línea del último mensaje. Botones:
   **Abrir PR** (si la rama está subida y origin es GitHub/GitLab/Bitbucket), **Ir al agente**,
   **Entendido**. Sustituye al aviso normal de "terminó".
3. Crea el recordatorio "Revisar <KEY> · <resumen>" a los `reviewReminderMinutes` (30; 0 = no).

El trabajo se busca primero en el repo del agente y, si Claude se fue a otro, en los repos que aparecen
en su transcript (`cd`, `git -C`, ficheros editados) y, por último, en todos los repos conocidos
(máx. 40): vale una rama local con la clave del ticket y commits desde que empezó. La tarjeta
indica el repo si no es el del agente.

Una sola vez por sesión y HEAD (`~/.cache/kaito/finished.json`). Sin commits nuevos, queda el
aviso normal (si trabajó 3 min o más).

### Resumen del día

Una vez al día, en el primer refresco a partir de las 06:00 (`dailySummary`,
`~/.cache/kaito/daily.json`): tickets en curso, recordatorios de hoy y agentes parados desde ayer.

### Activarlo y quitarlo

`./install.sh` y `./uninstall.sh` se encargan (ver Instalación). Lista de eventos que registra:
`Notification` (matcher `permission_prompt|elicitation_dialog|idle_prompt`), `PreToolUse`
(matcher `AskUserQuestion`), `PermissionRequest` (timeout 150), `PostToolUse`, `Stop`,
`UserPromptSubmit` y `SessionEnd`. Opcionalmente, `rm -r ~/.cache/kaito/state`; los estados con más
de 24 h se borran solos.

## Uso de Claude y Codex

Sección "Uso" arriba del menú (y de la tarjeta fija): una fila de columnas iguales, una por proveedor
activado (`agentProviders`). Cada columna es un anillo doble (fuera la ventana de 5 h, más gruesa; dentro la
semanal) con el logo del proveedor en el centro (el icono de su app si está instalado en el tema de iconos;
si no, su inicial), su nombre y una línea corta: "29 % · 65 %" (5 h · semana) o, si las ventanas ya se
reiniciaron, la antigüedad de los datos ("hace 6 d"). A la derecha de la cabecera, el próximo reinicio con
su proveedor ("Claude reinicia 14:50"). Verde < 70 %, naranja 70-90 %, rojo >= 90 %; lo reiniciado o viejo
sale atenuado. Al pasar el ratón por una columna, un tooltip da porcentajes y horas de reinicio. **Gemini CLI**
(si está instalado) sale como "sin datos de límite" (anillo con pista discontinua): su cuota vive en el servidor
y no guarda nada fiable en local, así que no se inventa ningún número. **OpenCode** no tiene límites propios: su columna dice qué proveedor usa
("usa tu Claude"), leído de `~/.config/opencode/opencode.json` (`model`) o del último modelo usado
(`~/.local/state/opencode/model.json`), solo lectura. En la barra superior, un mini anillo con el uso de
5 h del proveedor de Ajustes > General > "Anillo en la barra superior" (`usagePanelProvider`: `claude` por
defecto, `codex` o `none`). Se desactiva en Ajustes > General (`showUsage`). Lógica pura en `usage.js`
(`node usage.test.js`).

- **Claude**: Claude Code solo da los límites de suscripción a su `statusLine`. Actívala con
  `./install.sh --statusline` (`hooks/kaito-statusline.py`): guarda `~/.cache/kaito/claude-usage.json` (solo si Claude Code
  manda `rate_limits`, que aparecen tras la primera respuesta de la sesión) e imprime
  `<modelo> · 5h 42% · 7d 18%`. Si ya tienes un `statusLine`, encadena ese script con el tuyo.
  También desde Ajustes > General > **Datos de uso de Claude**: dice si la statusLine de
  `~/.claude/settings.json` es la de Kaito y la instala o quita (`hooks/merge-settings.py install|uninstall
  --statusline-only --apply`, con copia `settings.json.bak-kaito-*`). Si tienes otra barra de estado no la toca
  y te la muestra. `merge-settings.py status` lo consulta sin escribir nada.
- **Codex**: se lee el último evento `token_count` del rollout más reciente de
  `~/.codex/sessions/**/rollout-*.jsonl` (últimos 256 KB; como mucho cada 60 s). Solo se guardan
  números, nunca el contenido de la conversación. Los datos son de la última vez que usaste Codex.

## Captura rápida, notas y recordatorios

- Atajo global `Ctrl+Alt+Espacio` (configurable en Ajustes > General, clave GSettings `capture-shortcut`;
  `install.sh` compila el esquema con `glib-compile-schemas`). Abre un cuadro con pestañas
  (Tab para cambiar): **Nota**, **Recordatorio**, **Jira** y **Tarea** (ver Tareas programadas). En recordatorios escribe qué y cuándo:
  «llamar a Iker en 20 min», «mañana a las 9», «el lunes a las 10», «a las 17:30», «pasado mañana».
  Parser en `when.js` (`node when.test.js` lo prueba).
- Notas en `~/.config/kaito/notes.json`; recordatorios en `~/.config/kaito/reminders.json`.
  Clic en una nota del menú la copia al portapapeles.
- Cada 20 s (y al activar la extensión) se buscan recordatorios vencidos; salen como tarjeta no modal
  con "Posponer 10 min" y "Hecho". La duración del botón es `snoozeMinutes` (5, 10, 15, 30 o 60; Ajustes →
  «Posponer recordatorios»); el chevron de al lado ofrece 15 min, 30 min, 1 h, 3 h y «Mañana 9:00».

## Tareas programadas

Comprobaciones que antes hacías a mano y ahora hace Claude Code solo, a su hora:
«cada lunes a las 9 revisa en BigQuery las ventas de la semana pasada por tienda y avísame si alguna
cae más de un 20 %», o «mañana a las 10 revisa RUN-12326 que las carreras virtuales se generan bien en BQ».

- **Crear**: pestaña **Tarea** de la captura rápida. Escribe cuándo y qué; Enter pasa a la revisión
  (nombre editable, cuándo y próxima ejecución, carpeta y herramientas; `Ctrl+1…` cambia los campos,
  Enter guarda, Esc vuelve). Cuándo:
  - Recurrente: «todos los días a las 9[:30]», «cada día a las…», «todos los lunes [y jueves] a las…»,
    «de lunes a viernes a las…», «cada hora», «cada N horas», «cada N minutos» (mínimo 15),
    «el día 1 de cada mes a las…» (sin hora: 09:00). Si el día no existe (31 en febrero), el último del mes.
  - Una vez: lo mismo que los recordatorios («mañana a las 10», «en 2 horas», «el viernes a las 9»).
    Tras ejecutarse queda como «hecha» (con su historial) hasta que la borres.
- **Carpeta** (`cwd` de Claude): por defecto `~`, o la del ticket (abajo); el chip recorre los repos
  recientes de Claude. **Herramientas**:
  - *Solo lectura* (por defecto): solo `Read`, `Glob` y `Grep`, y leer solo dentro de la carpeta.
  - *Solo lectura + BigQuery* (se elige solo si el texto habla de bigquery, bq, tabla, dataset o sql):
    además las herramientas de lectura del servidor MCP `bigquery` (`list_dataset_ids`, `list_table_ids`,
    `get_dataset_info`, `get_table_info`, `search_catalog`, `execute_sql`), con el servidor en modo
    `BIGQUERY_WRITE_MODE=blocked` (MCP Toolbox: solo SELECT) y la orden de no modificar datos.
    El servidor se copia de `~/.claude.json` (`claude mcp add … bigquery`; otro nombre: `bqMcpServer` en `config.json`).
- **Tickets**: si el texto lleva una clave (`RUN-123`) la tarea queda vinculada. Al ejecutarse (no al
  crearla, para que esté al día) se lee el ticket completo de Jira (descripción, comentarios, estado,
  subtareas, enlaces) y el `git log --oneline -15` de su rama (la que contenga la clave, o HEAD), y se
  pide revisar que el cambio funciona. Carpeta por defecto: el repo con el que mandaste el ticket a Claude
  (`jiraRepoByIssue`), si no el del proyecto. Con un ticket, «datos» también activa BigQuery.
  Atajos: botón **Programar revisión** en cada ticket del menú y en la tarjeta «RUN-… listo».
- **Ejecución**: cada minuto (y 15 s después de activar la extensión) se lanzan las que tocan, de una en una:
  `claude -p --output-format stream-json --verbose --model sonnet --no-session-persistence`, prompt por
  stdin, máximo 10 min, `KAITO_TASK=1` (el hook de Kaito ignora esas sesiones). Si la sesión estuvo cerrada
  y se perdieron varias, se ejecuta **una** vez al volver. Al bloquear la pantalla GNOME desactiva la
  extensión: la tarea en curso se cancela y se repite al volver.
- **Resultado**: tarjeta en pantalla «Tarea «…» · terminada» (o «falló», en naranja) con el resumen
  (la línea `RESUMEN:` de la respuesta), «Ver completo» (texto entero, consultas SQL ejecutadas y Copiar),
  «Comentar en Jira» (solo con ticket: abre el comentario ya escrito con los hallazgos; se publica solo
  con Enter) y «Entendido».
- **Menú**: sección «Tareas programadas» (oculta si no hay ninguna): punto (verde ok, naranja falló,
  gris sin ejecutar), próxima ejecución, y botones Ejecutar ahora, Pausar/Reanudar y × (pide «¿Borrar?»).
  Clic en la fila: el último resultado. Ajustes > Tareas programadas las desactiva todas.
- **Datos**: `~/.config/kaito/tasks.json`; historial en `~/.local/share/kaito/task-runs/<id>/<fecha>.json`
  (`{started, finished, ok, summary, result, queries, error}`; se guardan las 20 últimas por tarea).

## Tablero de tareas

Opcional (Ajustes > Tablero y avisos > **Tablero de tareas**, `kanbanEnabled`; apagado por defecto). Convierte
los Pendientes en tareas con estado y prioridad, en un tablero de 4 columnas: **Por hacer**, **Haciendo**,
**En revisión** y **Hecho**.

- **Abrir**: menú > **Abrir tablero**, el atajo **Super+K** (`kanban-shortcut` en el esquema; también lo
  cierra) o `kaito kanban` desde la terminal (toca `~/.cache/kaito/open-kanban`, que la extensión vigila).
  Esc o un clic fuera lo cierran. **El atajo es una clave nueva del esquema (0.5.0): tras actualizar, cierra
  sesión y vuelve a entrar una vez**; hasta entonces funcionan el menú y `kaito kanban`.
- **Tablero**: cabecera con abiertas y hechas esta semana, búsqueda por texto o repo y **Nueva tarea**. Cada
  tarjeta: prioridad (⇈ ↑ = ↓), título, `K-<n>`, repo, «Claude trabajando» si hay un agente vivo con esa
  tarea, recordatorio si lo hay, y botones **←** / **→ <siguiente>** para moverla.
- **Detalle** (clic en una tarjeta): estado (clic: siguiente), prioridad (clic: cambia), título y descripción
  editables (se guardan al volver o cerrar), repo (el chip recorre los repos recientes; **Otra…** abre el
  buscador de carpetas, el mismo que el de Jira, y «Otra carpeta…» con zenity), y:
  - **Mandar a Claude**: igual que un ticket de Jira. Abre Claude en el repo con el prompt
    «Trabaja en la tarea K-<n>: <título>» + la descripción + el mismo párrafo de Git (rama
    `K-<n>-<resumen>`, commits con prefijo `K-<n>: `, `git push`, sin PR). La tarea pasa a **Haciendo**.
    Al terminar el agente con commits nuevos, la tarea pasa sola a **En revisión**, sale el aviso
    «K-<n> listo» y el recordatorio «Revisar K-<n>» (como con Jira, sin llamar a Jira).
  - **Programar revisión** (captura en la pestaña Tarea con «K-<n>: revisa que »), **Ir al agente** y
    **Borrar** (pide confirmación con un segundo clic).
- **Menú**: la sección «Pendientes» pasa a llamarse «Tareas» y cada fila muestra prioridad y estado; clic
  abre su detalle. La entrada del menú crea tareas.
- **Datos**: siguen en `~/.config/kaito/todos.json`, compatibles hacia atrás: cada pendiente gana
  `{id: "K-<n>", state: "todo"|"doing"|"review"|"done", priority, repo, description, created, updated}` y
  `done` se mantiene sincronizado con `state`, así que si desactivas el tablero la lista de Pendientes de
  siempre sigue funcionando (y lo que marques ahí como hecho pasa a **Hecho** al volver). El contador de
  `K-<n>` está en `~/.config/kaito/kanban.json` (no se reutilizan números).

## Panel de avisos

Opcional (Ajustes > Tablero y avisos > **Panel de avisos**, `inboxEnabled`; apagado por defecto). Un solo
sitio con todo lo que Kaito te cuenta: se abre con la **campana** del indicador (número de no leídos; punto
naranja si un agente te necesita) o con menú > **Avisos (N)**. Abrirlo los marca como leídos; un clic fuera
o Esc lo cierran.

- Agrupado por agente (o fuente: tareas programadas, recordatorios, Kaito) con su proveedor, repo y hora;
  «+N avisos» despliega los anteriores. **Borrar todo** lo vacía.
- En cada aviso: **Permitir** / **Denegar** si es una petición de permiso que aún espera (lo mismo que el
  cuadro de respuesta), un campo **Responder** (Enter: como Claude Code no admite texto desde fuera, se
  copia al portapapeles y te lleva a su terminal; queda «Respuesta copiada») y sus acciones (Ir al agente,
  Abrir PR, Revisar, Ver completo, Comentar en Jira, Actualizar, Posponer, Hecho).
- Pie: **No molestar** con − / + minutos (15–240) y **Activar** (`dndManual` + `dndUntil`).

Cómo sale cada aviso con el panel activado:

| Aviso | Trabajando | No molestar | Fuera de horario |
|---|---|---|---|
| Agente te necesita | Interrumpe (notificación + respuesta, como siempre) | Interrumpe | Solo panel, punto naranja |
| Recordatorio | Igual que siempre (tarjeta) | Sin sonido; con «Silenciar también recordatorios», solo panel | Igual que con No molestar |
| Agente terminó, «… listo», resultado de tarea programada | Aviso breve de GNOME (se va solo) | Solo panel | Solo panel |
| Actualización disponible | Solo panel (+ punto azul) | Solo panel | Solo panel |
| Resumen del día | Igual que siempre | Igual que siempre | Igual que siempre |
| Ticket creado, comentario publicado | Aviso breve, no se guarda | — | — |

Todo (salvo las confirmaciones) se guarda también en el panel, así que con el panel activado **no** sale la
tarjeta «Mientras no estabas» ni se quedan tarjetas fijas de «listo» o de tareas. Datos:
`~/.cache/kaito/inbox.json` (máximo 100 avisos, se borran a los 7 días, sin repetidos). Desactivado, todo
funciona como antes (tarjetas fijas, cola de No molestar y «Mientras no estabas»).
