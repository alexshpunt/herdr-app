//! A native program's own window shown inside a Herdr pane (Windows).
//!
//! A mod describes the launch (`open`): which program, its arguments and how
//! to recognize its window. The pane starts the program, or finds a window it
//! already shows, and adopts that top-level window. It moves into a container
//! child window that Herdr owns: the container follows the pane, crops the
//! program's own title bar and frame, and has overlays cut out of it. Closing
//! the pane gives the window back to the desktop and closes it, as its own
//! close button would. Herdr knows no program by name: the shipped `vscode`,
//! `fork` and `unity` mods describe theirs.
//!
//! Native calls on another process's window send messages to it. They run in
//! foreground tasks between App updates, never inside layout or paint, so a
//! reentrant message cannot meet a borrowed GPUI window.
use super::policy;
use gpui::{AnyElement, App, Bounds, HitboxBehavior, HitboxId, ParentElement, Pixels, Styled, Window, WindowId, canvas, div};
use gpui_shell::{ArgumentDescriptor, ArgumentSchema, ComponentArgument, ComponentDataValue, ComponentDescriptor, ComponentMaterializer, ComponentPayload, ComponentRegistry, ConstructorDescriptor, MaterializeRequest, StateDescriptor, StateMethodDescriptor};
use std::{cell::RefCell, path::PathBuf, rc::{Rc, Weak}, sync::Arc};

type State = Rc<RefCell<NativeApp>>;
thread_local! {
    static APPS: RefCell<Vec<Weak<RefCell<NativeApp>>>> = const { RefCell::new(Vec::new()) };
}

/// What a mod asks to start and how to recognize its windows (`open`).
#[derive(serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Description {
    /// Where the program may be: the first file that exists runs.
    program: Vec<String>,
    #[serde(default)]
    args: Vec<String>,
    /// Win32 class of the program's top-level windows; a trailing `*` matches
    /// any rest (WPF adds a GUID per run).
    class: String,
    /// What the title of a window already showing the target has as a
    /// " - "-separated part (or that part with " [...]" after it).
    #[serde(default)]
    title: String,
    /// Only a window of the started process is the pane's.
    #[serde(default)]
    own_process: bool,
    /// The program opens a target in one window only (Unity locks its
    /// project): a window already showing the target is adopted instead of
    /// starting it, and two panes with one key never start it twice.
    #[serde(default)]
    once: bool,
    /// The program's main window is the one with a Win32 menu bar (Unity),
    /// which it keeps: it is embedded as a popup, not as a child window.
    #[serde(default)]
    menu_window: bool,
    /// Seconds the program may take to show its window.
    #[serde(default = "default_wait")]
    wait: f64,
    /// The pane's error when no `program` path exists.
    #[serde(default)]
    missing: Option<String>,
}

fn default_wait() -> f64 {
    20.0
}

impl Description {
    fn parse(value: &ComponentDataValue) -> anyhow::Result<Self> {
        let description: Self = serde_json::from_value(plain(value)).map_err(|e| anyhow::anyhow!("Invalid launch description: {e}"))?;
        anyhow::ensure!(description.program.iter().any(|p| !p.trim().is_empty()), "The launch description names no program");
        anyhow::ensure!(!description.class.is_empty(), "The launch description names no window class");
        anyhow::ensure!(description.wait.is_finite() && description.wait > 0.0, "The launch description's wait must be a positive number of seconds");
        Ok(description)
    }

    /// The program to run: the first `program` path that is a file.
    fn program(&self) -> anyhow::Result<PathBuf> {
        self.program.iter().filter(|p| !p.trim().is_empty()).map(PathBuf::from).find(|p| p.is_file()).ok_or_else(|| {
            anyhow::anyhow!("{}", self.missing.clone().unwrap_or_else(|| format!("None of these programs exists: {}", self.program.join(", "))))
        })
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    fn launch(&self) -> anyhow::Result<Launch> {
        Ok(Launch {
            program: self.program()?, args: self.args.clone(), class: self.class.clone(), title: self.title.clone(),
            own_process: self.own_process, once: self.once, menu_window: self.menu_window,
            wait: std::time::Duration::from_secs_f64(self.wait),
        })
    }
}

/// Plain data from a mod as JSON.
fn plain(value: &ComponentDataValue) -> serde_json::Value {
    use serde_json::Value;
    match value {
        ComponentDataValue::Null => Value::Null,
        ComponentDataValue::Boolean(b) => Value::Bool(*b),
        ComponentDataValue::Number(n) => serde_json::Number::from_f64(*n).map_or(Value::Null, Value::Number),
        ComponentDataValue::String(s) => Value::String(s.clone()),
        ComponentDataValue::Array(items) => Value::Array(items.iter().map(plain).collect()),
        ComponentDataValue::Object(fields) => Value::Object(fields.iter().map(|(k, v)| (k.clone(), plain(v))).collect()),
    }
}

/// A launch description with its program found.
#[derive(Clone, Debug)]
#[cfg_attr(not(windows), allow(dead_code))]
struct Launch {
    program: PathBuf,
    args: Vec<String>,
    class: String,
    title: String,
    own_process: bool,
    once: bool,
    menu_window: bool,
    wait: std::time::Duration,
}

/// A rectangle in device pixels, relative to the host window's client area.
type Rect = [i32; 4];

// The key and launch details are used by the Windows backend only.
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) struct NativeApp {
    window: WindowId,
    /// What the window shows: a restarted copy of the mod, or another pane
    /// with the same key, takes the window over.
    key: String,
    /// The mod's launch description, once it gave one.
    description: Option<Description>,
    status: String,
    error: Option<String>,
    hitbox: Option<HitboxId>,
    rect: Option<Rect>,
    visible: bool,
    holes: Vec<[i32; 4]>,
    apply_pending: bool,
    /// Bumped by reopen, so an older watcher task ends.
    generation: u64,
    /// The window was closed; only reopen asks for a new one.
    closed: bool,
    /// Keyboard focus was asked for while the pane was hidden: give it when
    /// the pane shows up soon after (a tab selected just before).
    focus_until: Option<std::time::Instant>,
    /// How the shown window came (`origin`): "new" (started, or found by its
    /// title), "restart" (kept from a restarted copy of this pane's mod) or
    /// "pane" (taken from another pane with the same key).
    origin: Option<&'static str>,
    #[cfg(windows)]
    embedded: Option<win::Embedded>,
    #[cfg(windows)]
    opening: bool,
}

/// A program of the person's, started without the IPC variables of the
/// VS Code or other Electron app Herdr may run in: with them an Electron
/// program acts as a CLI or Node instead.
fn person_program(program: &std::path::Path) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy();
        if name.starts_with("VSCODE_") || name.starts_with("ELECTRON_") { command.env_remove(&key); }
    }
    command
}

/// Runs `program` with `args` after the runs asked for before have ended, on
/// one worker thread: a single-instance program (VS Code's `--goto`) gets
/// them in the order asked. The UI thread never waits for a run.
fn run_again(program: PathBuf, args: Vec<String>) {
    type Run = (PathBuf, Vec<String>);
    static QUEUE: std::sync::OnceLock<std::sync::Mutex<std::sync::mpsc::Sender<Run>>> = std::sync::OnceLock::new();
    let queue = QUEUE.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<Run>();
        let _ = std::thread::Builder::new().name("native-app-runs".into()).spawn(move || {
            for (program, args) in rx {
                let child = person_program(&program).args(&args)
                    .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
                match child {
                    Ok(mut child) => { let _ = child.wait(); }
                    Err(error) => tracing::warn!(%error, "cannot run {}", program.display()),
                }
            }
        });
        std::sync::Mutex::new(tx)
    });
    let _ = queue.lock().unwrap_or_else(std::sync::PoisonError::into_inner).send((program, args));
}

/// A window class against a `Description.class` pattern.
#[cfg_attr(not(windows), allow(dead_code))]
fn class_matches(pattern: &str, class: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => class.starts_with(prefix),
        None => class == pattern,
    }
}

/// Whether a window title has `part` as a " - "-separated part, or that
/// part with " [...]" after it (VS Code's " [WSL: Ubuntu]").
#[cfg_attr(not(windows), allow(dead_code))]
fn title_shows(title: &str, part: &str) -> bool {
    !part.is_empty() && title.split(" - ").any(|p| p == part || p.strip_prefix(part).is_some_and(|rest| rest.starts_with(" [")))
}

impl Drop for NativeApp {
    fn drop(&mut self) {
        // A mod that restarts (a reload) makes a new state at once: it takes
        // the window back within a moment, or the window closes.
        #[cfg(windows)]
        if let Some(embedded) = self.embedded.take() { win::orphan(&self.key, embedded); }
    }
}

impl NativeApp {
    fn layout(&mut self, bounds: Bounds<Pixels>, window: &mut Window) {
        self.hitbox = Some(window.insert_hitbox(bounds, HitboxBehavior::Normal).id);
        let scale = window.scale_factor();
        let px = |v: Pixels| (f32::from(v) * scale).round() as i32;
        self.rect = Some([px(bounds.origin.x), px(bounds.origin.y), px(bounds.size.width), px(bounds.size.height)]);
    }

    fn update_visibility(&mut self, window: &Window, dragging: bool, covers: &[Bounds<Pixels>]) {
        let hitbox = self.hitbox.and_then(|id| window.prepainted_hitbox(id));
        let scale = window.scale_factor();
        // The parts outside the pane's clip mask are cut out like overlays.
        let mut covers = covers.to_vec();
        if let Some(hitbox) = hitbox.as_ref() {
            covers.extend(policy::outside_mask(&hitbox.bounds, &hitbox.content_mask.bounds, scale));
        }
        let covered = dragging || hitbox.is_some_and(|hitbox| policy::fully_covered(&hitbox.bounds, &covers));
        self.visible = policy::should_show(hitbox.is_some(), true, covered);
        self.holes = hitbox.map(|hitbox| policy::holes(&hitbox.bounds, &covers, scale)).unwrap_or_default();
    }

    /// The native state differs from the latest layout.
    fn needs_apply(&self) -> bool {
        #[cfg(windows)]
        if let (Some(embedded), Some(rect)) = (&self.embedded, self.rect) {
            return embedded.applied.as_ref() != Some(&(rect, self.visible, self.holes.clone()));
        }
        false
    }
}

/// Open the program's window on first use. Runs between App updates on Windows.
fn start(state: &State, window: &mut Window, cx: &mut App) {
    #[cfg(windows)]
    win::start(state, window, cx, true);
    #[cfg(not(windows))]
    {
        let _ = (window, cx);
        let mut app = state.borrow_mut();
        if app.error.is_none() {
            app.error = Some("Embedding native apps is only available on Windows.".into());
        }
    }
}

fn schedule_apply(state: &State, window: &mut Window, cx: &mut App) {
    {
        let mut app = state.borrow_mut();
        if app.apply_pending || !app.needs_apply() { return; }
        app.apply_pending = true;
    }
    #[cfg(windows)]
    {
        let weak = Rc::downgrade(state);
        window.spawn(cx, async move |_| {
            if let Some(state) = weak.upgrade() { win::apply(&state); }
        }).detach();
    }
    #[cfg(not(windows))]
    let _ = (window, cx);
}

/// Called from the browser's end-of-frame canvas: show, hide or cut each
/// embedded window for overlays, clipping and inactive tabs.
pub(super) fn end_frame(dragging: bool, covers: &[Bounds<Pixels>], window: &mut Window, cx: &mut App) {
    let id = window.window_handle().window_id();
    let apps: Vec<State> = APPS.with_borrow_mut(|apps| {
        apps.retain(|weak| weak.strong_count() > 0);
        apps.iter().filter_map(Weak::upgrade).filter(|app| app.borrow().window == id).collect()
    });
    for app in &apps {
        app.borrow_mut().update_visibility(window, dragging, covers);
    }
    for app in &apps {
        schedule_apply(app, window, cx);
    }
}

struct NativeAppElement;
impl ComponentMaterializer for NativeAppElement {
    fn materialize(&self, mut request: MaterializeRequest<'_>) -> anyhow::Result<AnyElement> {
        let argument = request.payload().downcast_ref::<ComponentArgument>().unwrap().clone();
        let state = request.with_state::<State, _>(&argument, Clone::clone)?;
        request.with_window_app(|window, cx| {
            start(&state, window, cx);
            Ok(())
        })?;
        let element = div().size_full().child(canvas(move |bounds, window, cx| {
            state.borrow_mut().layout(bounds, window);
            schedule_apply(&state, window, cx);
        }, |_, _, _, _| {}).size_full());
        request.finish(element)
    }
}

pub(super) fn register(registry: &mut ComponentRegistry) {
    registry.register_state(StateDescriptor::new(
        "NativeAppState", "HerdrNativeAppState",
        vec![ArgumentDescriptor::new("key", ArgumentSchema::String)],
        |args, window, cx| {
            let ComponentArgument::String(key) = &args[0] else { unreachable!() };
            let state = Rc::new(RefCell::new(NativeApp {
                window: window.window_handle().window_id(), key: key.clone(), description: None,
                status: "Opening…".into(), error: None, hitbox: None, rect: None, visible: false, holes: Vec::new(),
                apply_pending: false, generation: 0, closed: false, focus_until: None, origin: None,
                #[cfg(windows)] embedded: None,
                #[cfg(windows)] opening: false,
            }));
            APPS.with_borrow_mut(|apps| apps.push(Rc::downgrade(&state)));
            // A failed candidate init must not take the live copy's window.
            // Defer the handoff until the update commits, without retaining
            // a candidate state that reload rolled back.
            #[cfg(windows)]
            {
                let weak = Rc::downgrade(&state);
                window.defer(cx, move |window, cx| {
                    if let Some(state) = weak.upgrade() { win::start(&state, window, cx, false); }
                });
            }
            #[cfg(not(windows))]
            let _ = cx;
            Ok(Box::new(state))
        },
    ).with_documentation("A program's own window shown in this pane (Windows), started from the launch description `open` gives. `key` names what the window shows: a restarted mod, or another pane with the same key, takes that window over. Closing the pane closes the window.")
    .with_methods(vec![
        StateMethodDescriptor::new::<State>("status", "(): string", |state, _, _, _| {
            Ok(ComponentDataValue::String(state.borrow().status.clone()))
        }).with_readonly(true),
        StateMethodDescriptor::new::<State>("error", "(): string | null", |state, _, _, _| {
            Ok(state.borrow().error.clone().map(ComponentDataValue::String).unwrap_or(ComponentDataValue::Null))
        }).with_readonly(true),
        StateMethodDescriptor::new::<State>("shown", "(): boolean", |state, _, _, _| {
            #[cfg(windows)]
            return Ok(ComponentDataValue::Boolean(state.borrow().embedded.is_some()));
            #[cfg(not(windows))]
            { let _ = state; Ok(ComponentDataValue::Boolean(false)) }
        }).with_readonly(true),
        // A closed or failed window starts again from the same launch.
        StateMethodDescriptor::new::<State>("reopen", "(): void", |state, _, _, _| {
            let mut app = state.borrow_mut();
            if app.closed || app.error.is_some() {
                app.generation += 1;
                app.closed = false;
                app.error = None;
                app.status = "Opening…".into();
            }
            Ok(ComponentDataValue::Null)
        }),
        StateMethodDescriptor::new::<State>("origin", "(): \"new\" | \"restart\" | \"pane\" | null", |state, _, _, _| {
            Ok(state.borrow().origin.map_or(ComponentDataValue::Null, |o| ComponentDataValue::String(o.into())))
        }).with_readonly(true),
        // When Herdr adopted the window (milliseconds since 1970), null
        // before: a window taken from another pane keeps its first time.
        StateMethodDescriptor::new::<State>("embeddedAt", "(): number | null", |state, _, _, _| {
            #[cfg(windows)]
            return Ok(state.borrow().embedded.as_ref().map_or(ComponentDataValue::Null, |e| ComponentDataValue::Number(win::adopted_ms(e))));
            #[cfg(not(windows))]
            { let _ = state; Ok(ComponentDataValue::Null) }
        }).with_readonly(true),
        StateMethodDescriptor::new::<State>("open", "(launch: { program: string[]; args?: string[]; class: string; title?: string; ownProcess?: boolean; once?: boolean; menuWindow?: boolean; wait?: number; missing?: string }): void", |state, args, _, _| {
            let description = Description::parse(args.first().unwrap_or(&ComponentDataValue::Null))?;
            let mut app = state.borrow_mut();
            match &app.description {
                Some(given) if *given != description => anyhow::bail!("This state already has a launch: open another target with a new NativeAppState"),
                Some(_) => {}
                None => app.description = Some(description),
            }
            Ok(ComponentDataValue::Null)
        }),
        // A single-instance program takes later requests through a run of
        // its own (VS Code: `--goto --file-uri <uri>` opens a file in the
        // window that has its folder).
        StateMethodDescriptor::new::<State>("run", "(args: string[]): void", |state, args, _, _| {
            let Some(ComponentDataValue::Array(items)) = args.first() else { anyhow::bail!("Expected the arguments as a list of strings") };
            let args = items.iter().map(|v| match v { ComponentDataValue::String(s) => Ok(s.clone()), _ => Err(anyhow::anyhow!("Expected the arguments as a list of strings")) }).collect::<anyhow::Result<Vec<_>>>()?;
            let program = state.borrow().description.as_ref().ok_or_else(|| anyhow::anyhow!("No launch yet: call open first"))?.program()?;
            run_again(program, args);
            Ok(ComponentDataValue::Null)
        }),
        StateMethodDescriptor::new::<State>("focus", "(): void", |state, _, _, _| {
            // Every copy of a mod gets its commands: only a pane shown within a
            // second takes the keyboard. The next frame gives it, outside this
            // App update (SetFocus sends messages to Herdr's window at once).
            let mut app = state.borrow_mut();
            app.focus_until = Some(std::time::Instant::now() + std::time::Duration::from_secs(1));
            #[cfg(windows)]
            if let Some(embedded) = app.embedded.as_mut() { embedded.applied = None; }
            Ok(ComponentDataValue::Null)
        }),
    ])).unwrap();
    registry.register(ComponentDescriptor::new("NativeApp", Arc::new(NativeAppElement))
        .with_documentation("The window of a NativeAppState, filling this element. Retain the state in init.")
        .with_constructors(vec![ConstructorDescriptor::new("NativeApp", vec![ArgumentDescriptor::new("state", ArgumentSchema::Entity("HerdrNativeAppState"))], |args| Ok(ComponentPayload::new(args[0].clone())))])
        .with_methods(vec![])).unwrap();
}

#[cfg(windows)]
mod win {
    use super::{Launch, Rect, State};
    use gpui::{App, Window};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::{cell::{Cell, RefCell}, rc::Rc, time::{Duration, Instant}};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::Gdi::ClientToScreen,
        System::{LibraryLoader::GetModuleHandleW, Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW}},
        UI::Input::KeyboardAndMouse::SetFocus,
        UI::WindowsAndMessaging::*,
    };

    /// An adopted window in its container.
    pub(super) struct Embedded {
        pub(super) child: HWND,
        container: HWND,
        /// The window's own styles, restored when it goes back to the desktop.
        style: isize,
        ex_style: isize,
        /// Device pixels of the window cut off at each side: its title bar and frame.
        crop: Crop,
        pub(super) applied: Option<(Rect, bool, Vec<[i32; 4]>)>,
        /// A popup inside the container (Unity's main window, which keeps
        /// its menu bar). It shares no input queue with Herdr, so a busy
        /// program never stalls Herdr as long as Herdr makes no synchronous
        /// calls on it; it takes the keyboard as the foreground window
        /// (see `focus`).
        popup: bool,
        /// The program's other windows of the same class (Unity's floating
        /// editor windows), hidden while the pane is.
        hidden: Vec<HWND>,
        /// When Herdr adopted it (`embeddedAt`): a new VS Code window still
        /// connects to its machine for a while after that.
        adopted: std::time::SystemTime,
    }

    /// When Herdr adopted the window, in milliseconds since 1970.
    pub(super) fn adopted_ms(embedded: &Embedded) -> f64 {
        embedded.adopted.duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
    }

    #[derive(Clone, Copy, Default, PartialEq, Debug)]
    pub(super) struct Crop { left: i32, top: i32, right: i32, bottom: i32 }

    impl Drop for Embedded {
        fn drop(&mut self) {
            focus::forget(self.container);
            // Another process's window: give it back to the desktop and close
            // it from a helper thread, so its sent messages never reenter an
            // App update. A clean window closes at once; one with unsaved
            // changes shows its own save prompt on the desktop.
            let (child, container, style, ex_style, hidden) = (self.child as usize, self.container as usize, self.style, self.ex_style, std::mem::take(&mut self.hidden).into_iter().map(|h| h as usize).collect::<Vec<_>>());
            let screen = screen_rect(self.container);
            let _ = std::thread::Builder::new().name("native-app-release".into()).spawn(move || {
                release(child as HWND, style, ex_style, screen);
                // A save prompt the person cancels keeps the program open.
                for hwnd in hidden { unsafe { ShowWindowAsync(hwnd as HWND, SW_SHOWNOACTIVATE) }; }
                unsafe {
                    PostMessageW(child as HWND, WM_CLOSE, 0, 0);
                    // DestroyWindow must run on the container's own thread.
                    PostMessageW(container as HWND, WM_CLOSE, 0, 0);
                }
            });
        }
    }

    fn screen_rect(hwnd: HWND) -> RECT {
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        unsafe { GetWindowRect(hwnd, &mut r) };
        r
    }

    /// The window back on the desktop, where the pane showed it.
    fn release(child: HWND, style: isize, ex_style: isize, at: RECT) {
        unsafe {
            if IsWindow(child) == 0 { return; }
            SetWindowLongPtrW(child, GWL_STYLE, style & !(WS_VISIBLE as isize) & !(WS_MAXIMIZE as isize));
            SetWindowLongPtrW(child, GWL_EXSTYLE, ex_style);
            SetParent(child, std::ptr::null_mut());
            let (w, h) = (at.right - at.left, at.bottom - at.top);
            if w > 0 && h > 0 {
                SetWindowPos(child, HWND_TOP, at.left, at.top, w, h, SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
            } else {
                ShowWindow(child, SW_SHOWNOACTIVATE);
            }
        }
    }

    thread_local! {
        static QUIT_HOOKED: Cell<bool> = const { Cell::new(false) };
        /// Windows of dropped states, by key, until a new state takes them or
        /// their time is up.
        static ORPHANS: std::cell::RefCell<Vec<(String, Embedded, Instant)>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    /// How long a dropped state's window waits for a restarted mod.
    const ORPHAN_GRACE: Duration = Duration::from_secs(2);

    /// Keep a dropped state's window, hidden, for a state that takes it soon.
    /// Runs inside App updates: posted calls only.
    pub(super) fn orphan(key: &str, embedded: Embedded) {
        unsafe { ShowWindowAsync(embedded.container, SW_HIDE) };
        ORPHANS.with_borrow_mut(|o| o.push((key.to_owned(), embedded, Instant::now() + ORPHAN_GRACE)));
    }

    // Hidden states can reclaim windows, but only a rendered element may
    // launch a new program. Construction and materialization share the handoff.
    pub(super) fn start(state: &State, window: &mut Window, cx: &mut App, launch_new: bool) {
        let (generation, key, description) = {
            let app = state.borrow();
            if app.embedded.is_some() || app.opening || app.error.is_some() || app.closed { return; }
            (app.generation, app.key.clone(), app.description.clone())
        };
        let saved = kept(state, &key);
        if saved.is_none() && (!launch_new || description.is_none()) { return; }
        if !QUIT_HOOKED.get() {
            QUIT_HOOKED.set(true);
            // Quitting Herdr closes every adopted window as its own close
            // button would. Only posted messages: this runs inside an App update.
            cx.on_app_quit(|_| {
                let close = |e: Embedded| {
                    let e = std::mem::ManuallyDrop::new(e);
                    unsafe { PostMessageW(e.child, WM_CLOSE, 0, 0) };
                };
                super::APPS.with_borrow(|apps| {
                    for app in apps.iter().filter_map(std::rc::Weak::upgrade) {
                        if let Some(e) = app.borrow_mut().embedded.take() { close(e); }
                    }
                });
                for (_, e, _) in ORPHANS.take() { close(e); }
                async {}
            }).detach();
            // Close the windows nobody took back.
            cx.spawn(async |cx| loop {
                cx.background_executor().timer(Duration::from_millis(500)).await;
                let now = Instant::now();
                let expired: Vec<_> = ORPHANS.with_borrow_mut(|o| o.extract_if(.., |(_, _, until)| *until <= now).collect());
                drop(expired);
            }).detach();
        }
        let host = match HasWindowHandle::window_handle(window).map(|h| h.as_raw()) {
            Ok(RawWindowHandle::Win32(handle)) => handle.hwnd.get() as HWND,
            _ => { fail(state, "No Win32 host window".into()); return; }
        };
        // A pane whose mod restarted (a mod reload, a layout change) gets the
        // window its earlier copy still holds for the same key: VS Code
        // would only bring that window forward instead of opening another.
        if let Some((embedded, origin)) = saved {
            let embedded = moved_to(embedded, host);
            let child = embedded.child as usize;
            show(state, embedded, origin);
            let weak = Rc::downgrade(state);
            window.spawn(cx, async move |cx| {
                let _ = cx.update(|window, _| window.refresh());
                watch_loop(weak, generation, child, cx).await;
            }).detach();
            return;
        }
        // Only a new window needs a launch or an executable on disk.
        let launch = match description.expect("a new window has a launch").launch() {
            Ok(launch) => launch,
            Err(error) => { fail(state, format!("{error:#}")); return; }
        };
        state.borrow_mut().opening = true;
        let weak = Rc::downgrade(state);
        window.spawn(cx, async move |cx| {
            // A program that opens a target once (Unity): one start per key,
            // and a later pane takes the window.
            let starting = if launch.once {
                while STARTING.with_borrow(|s| s.contains(&key)) {
                    let Some(state) = wanted(&weak, generation) else { return };
                    state.borrow_mut().status = format!("Waiting for another {} to start…", launch.program.file_stem().unwrap_or_default().to_string_lossy());
                    drop(state);
                    cx.background_executor().timer(Duration::from_millis(100)).await;
                }
                // A start whose pane went away meanwhile left its window; a
                // pane that got it keeps it until this one takes it.
                let Some(state) = wanted(&weak, generation) else { return };
                if let Some((embedded, origin)) = kept(&state, &key) {
                    let child = embedded.child as usize;
                    show(&state, moved_to(embedded, host), origin);
                    drop(state);
                    let _ = cx.update(|window, _| window.refresh());
                    watch_loop(weak, generation, child, cx).await;
                    return;
                }
                Some(Starting::new(key.clone()))
            } else { None };
            let Some(state) = wanted(&weak, generation) else { return };
            let before = program_windows(&launch);
            // A pane that goes away (a mod restarting) leaves a started
            // process of its own: its window waits for the pane's next state.
            let mut abandoned = false;
            // A program that opens a target once: a window already on it
            // comes into the pane instead.
            let open = if launch.once { showing(&before, &launch.title) } else { None };
            let found = if let Some(hwnd) = open { drop(state); hwnd } else {
                let foreground = unsafe { GetForegroundWindow() };
                let mut child = match run(&launch) {
                    Ok(child) => child,
                    Err(error) => {
                        fail(&state, format!("Cannot start {}: {error}", launch.program.display()));
                        let _ = cx.update(|window, _| window.refresh());
                        return;
                    }
                };
                let pid = child.id();
                state.borrow_mut().status = "Waiting for its window…".into();
                drop(state);
                let opened = Instant::now();
                // Adopt the new window.
                loop {
                    cx.background_executor().timer(Duration::from_millis(100)).await;
                    if !abandoned && wanted(&weak, generation).is_none() {
                        if !launch.own_process { return; }
                        abandoned = true;
                    }
                    let mut now = program_windows(&launch);
                    if launch.own_process { now.retain(|&hwnd| window_pid(hwnd) == pid); }
                    if let Some(&hwnd) = now.iter().find(|h| !before.contains(h)) { break hwnd; }
                    // A program that already shows this target brings that
                    // window to the front instead of opening another. Windows
                    // may not let it come forward: then it is found by its title.
                    let front = unsafe { GetForegroundWindow() };
                    if opened.elapsed() > Duration::from_secs(2) && front != foreground && now.contains(&front) { break front; }
                    if opened.elapsed() > Duration::from_secs(3) && let Some(hwnd) = showing(&now, &launch.title) { break hwnd; }
                    let failed = match child.try_wait() {
                        Ok(Some(status)) => launch.own_process || !status.success(),
                        _ => false,
                    };
                    if failed || opened.elapsed() > launch.wait {
                        if !abandoned && let Some(state) = weak.upgrade() {
                            let mut app = state.borrow_mut();
                            app.opening = false;
                            app.error = Some(format!("{} did not open a window", launch.program.file_name().unwrap_or_default().to_string_lossy()));
                            let _ = cx.update(|window, _| window.refresh());
                        }
                        return;
                    }
                }
            };
            let mut embedded = embed(found, host, launch.menu_window, cx).await;
            let child = found as usize;
            // The container stays hidden until the crop is known.
            embedded.crop = cx.background_executor().spawn(async move { measure(child as HWND) }).await;
            let state = if abandoned { None } else { wanted(&weak, generation) };
            let Some(state) = state else { orphan(&key, embedded); return };
            drop(starting);
            show(&state, embedded, "new");
            let _ = cx.update(|window, _| window.refresh());
            apply(&state);
            focus::give(found);
            // Only the pane holds its state: closing the pane drops it, and
            // with it the window.
            drop(state);
            watch_loop(weak, generation, child, cx).await;
        }).detach();
    }

    thread_local! {
        /// The keys of `once` launches starting now: a second one with the
        /// same key waits, then takes the first one's window.
        static STARTING: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    /// Holds its key in `STARTING` until dropped.
    struct Starting(String);
    impl Starting {
        fn new(key: String) -> Self { STARTING.with_borrow_mut(|s| s.push(key.clone())); Starting(key) }
    }
    impl Drop for Starting {
        fn drop(&mut self) { STARTING.with_borrow_mut(|s| s.retain(|k| *k != self.0)); }
    }

    fn window_pid(hwnd: HWND) -> u32 {
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        pid
    }

    fn run(launch: &Launch) -> std::io::Result<std::process::Child> {
        super::person_program(&launch.program).args(&launch.args)
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .spawn()
    }

    fn fail(state: &State, error: String) {
        let mut app = state.borrow_mut();
        app.opening = false;
        app.error = Some(error);
    }

    /// The state, while it still wants this start's window. A state that
    /// moved on stops opening.
    fn wanted(weak: &std::rc::Weak<std::cell::RefCell<super::NativeApp>>, generation: u64) -> Option<State> {
        let state = weak.upgrade()?;
        if state.borrow().generation != generation {
            state.borrow_mut().opening = false;
            return None;
        }
        Some(state)
    }

    fn show(state: &State, embedded: Embedded, origin: &'static str) {
        let mut app = state.borrow_mut();
        app.opening = false;
        app.embedded = Some(embedded);
        app.origin = Some(origin);
        app.status = "Hidden while its pane is covered.".into();
    }

    /// A window with this key that is already open: one a restarted copy of
    /// the mod left ("restart"), else one another pane shows ("pane").
    fn kept(state: &State, key: &str) -> Option<(Embedded, &'static str)> {
        let left = ORPHANS.with_borrow_mut(|o| o.iter().position(|(k, _, _)| k == key).map(|i| o.remove(i).1));
        left.map(|e| (e, "restart")).or_else(|| held(state, key).map(|e| (e, "pane")))
    }

    fn moved_to(mut embedded: Embedded, host: HWND) -> Embedded {
        embedded.applied = None;
        unsafe {
            if GetParent(embedded.container) != host { SetParent(embedded.container, host); }
        }
        embedded
    }

    /// The window another live state with the same key holds, taken from
    /// it. One pane per key: the newest one shows its window.
    fn held(state: &State, key: &str) -> Option<Embedded> {
        let other = super::APPS.with_borrow(|apps| {
            apps.iter().filter_map(std::rc::Weak::upgrade).find(|other| {
                if Rc::ptr_eq(other, state) { return false; }
                let o = other.borrow();
                o.key == key && o.embedded.is_some()
            })
        })?;
        let mut o = other.borrow_mut();
        let embedded = o.embedded.take()?;
        o.generation += 1;
        o.closed = true;
        o.status = "Moved to another pane.".into();
        Some(embedded)
    }

    /// Watch an adopted window: closed by its own button, moved by its title
    /// bar, or a title bar that changed height.
    async fn watch_loop(weak: std::rc::Weak<std::cell::RefCell<super::NativeApp>>, generation: u64, child: usize, cx: &mut gpui::AsyncWindowContext) {
        for tick in 1u64.. {
            cx.background_executor().timer(Duration::from_millis(250)).await;
            let Some(state) = weak.upgrade() else { return };
            if state.borrow().generation != generation { return; }
            // Zoom or the command center can change the title bar's height.
            if tick % 8 == 0 {
                let crop = cx.background_executor().spawn(async move { measure(child as HWND) }).await;
                let mut app = state.borrow_mut();
                if let Some(e) = app.embedded.as_mut().filter(|e| e.crop != crop) {
                    tracing::debug!(?crop, "native app crop changed");
                    e.crop = crop;
                    e.applied = None;
                }
            }
            if watch(&state) {
                let _ = cx.update(|window, _| window.refresh());
            }
            if state.borrow().embedded.is_none() { return; }
        }
    }

    /// One watcher step. Returns whether to redraw.
    fn watch(state: &State) -> bool {
        let mut app = state.borrow_mut();
        let Some(embedded) = app.embedded.as_mut() else { return false };
        if unsafe { IsWindow(embedded.child) } == 0 || unsafe { GetAncestor(embedded.child, GA_PARENT) } != embedded.container {
            // Closed by the program: nothing to give back.
            let e = std::mem::ManuallyDrop::new(app.embedded.take().unwrap());
            app.closed = true;
            app.status = "Closed.".into();
            drop(app);
            focus::forget(e.container);
            unsafe { DestroyWindow(e.container) };
            return true;
        }
        // Its own minimize button: show it again in the pane (posted, so no
        // message reaches this process while the state is borrowed).
        if unsafe { IsIconic(embedded.child) } != 0 {
            unsafe { ShowWindowAsync(embedded.child, SW_SHOWNOACTIVATE) };
            embedded.applied = None;
        }
        // The program may move or resize its own window: put it back.
        if let Some((rect, _, _)) = &embedded.applied {
            let expected = child_rect(rect[2], rect[3], embedded.crop);
            if current(embedded.child) != expected { embedded.applied = None; }
        }
        drop(app);
        apply(state);
        false
    }

    /// The child's place inside a container of `width` x `height`.
    fn child_rect(width: i32, height: i32, crop: Crop) -> [i32; 4] {
        [-crop.left, -crop.top, width + crop.left + crop.right, height + crop.top + crop.bottom]
    }

    /// The window's rectangle in its parent's client coordinates.
    fn current(hwnd: HWND) -> [i32; 4] {
        let r = screen_rect(hwnd);
        let mut origin = POINT { x: r.left, y: r.top };
        unsafe {
            let parent = GetAncestor(hwnd, GA_PARENT);
            let mut zero = POINT { x: 0, y: 0 };
            ClientToScreen(parent, &mut zero);
            origin.x -= zero.x;
            origin.y -= zero.y;
        }
        [origin.x, origin.y, r.right - r.left, r.bottom - r.top]
    }

    fn image_path(pid: u32) -> Option<String> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() { return None; }
            let mut buffer = [0u16; 1024];
            let mut len = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut len);
            CloseHandle(process);
            (ok != 0).then(|| String::from_utf16_lossy(&buffer[..len as usize]))
        }
    }

    /// The one window whose title shows `part` (`title_shows`).
    fn showing(windows: &[HWND], part: &str) -> Option<HWND> {
        if part.is_empty() { return None; }
        let matches: Vec<HWND> = windows.iter().copied().filter(|&hwnd| {
            let mut text = [0u16; 512];
            let len = unsafe { GetWindowTextW(hwnd, text.as_mut_ptr(), text.len() as i32) };
            super::title_shows(&String::from_utf16_lossy(&text[..len.max(0) as usize]), part)
        }).collect();
        (matches.len() == 1).then(|| matches[0])
    }

    /// Visible, unowned top-level windows of the launch's program.
    fn program_windows(launch: &Launch) -> Vec<HWND> {
        struct Search<'a> { class: &'a str, menu: bool, program: String, found: Vec<HWND>, checked: Vec<(u32, bool)> }
        unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> windows_sys::core::BOOL {
            let search = unsafe { &mut *(data as *mut Search) };
            if unsafe { IsWindowVisible(hwnd) } == 0 || !unsafe { GetWindow(hwnd, GW_OWNER) }.is_null() { return 1; }
            // The class first: a title read can send a message to a window
            // of this process, such as Herdr's own.
            let mut name = [0u16; 128];
            let len = unsafe { GetClassNameW(hwnd, name.as_mut_ptr(), name.len() as i32) };
            if !super::class_matches(search.class, &String::from_utf16_lossy(&name[..len.max(0) as usize])) { return 1; }
            if search.menu && unsafe { GetMenu(hwnd) }.is_null() { return 1; }
            let mut pid = 0;
            unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
            if pid == std::process::id() || unsafe { GetWindowTextLengthW(hwnd) } == 0 { return 1; }
            let ours = match search.checked.iter().find(|(p, _)| *p == pid) {
                Some(&(_, ours)) => ours,
                None => {
                    let ours = image_path(pid).is_some_and(|path| path.eq_ignore_ascii_case(&search.program));
                    search.checked.push((pid, ours));
                    ours
                }
            };
            if ours { search.found.push(hwnd); }
            1
        }
        let program = std::fs::canonicalize(&launch.program).map(|p| p.to_string_lossy().trim_start_matches(r"\\?\").to_owned())
            .unwrap_or_else(|_| launch.program.to_string_lossy().into_owned());
        let mut search = Search { class: &launch.class, menu: launch.menu_window, program, found: Vec::new(), checked: Vec::new() };
        unsafe { EnumWindows(Some(visit), (&raw mut search) as LPARAM) };
        search.found
    }

    /// The visible top-level windows of `child`'s process and class, other
    /// than `child`: Unity's floating editor windows.
    fn floating_windows(child: HWND) -> Vec<HWND> {
        struct Search { child: HWND, pid: u32, class: Vec<u16>, found: Vec<HWND> }
        fn class(hwnd: HWND) -> Vec<u16> {
            let mut name = [0u16; 128];
            let len = unsafe { GetClassNameW(hwnd, name.as_mut_ptr(), name.len() as i32) };
            name[..len.max(0) as usize].to_vec()
        }
        unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> windows_sys::core::BOOL {
            let search = unsafe { &mut *(data as *mut Search) };
            if hwnd == search.child || unsafe { IsWindowVisible(hwnd) } == 0 || window_pid(hwnd) != search.pid { return 1; }
            if class(hwnd) == search.class { search.found.push(hwnd); }
            1
        }
        let mut search = Search { child, pid: window_pid(child), class: class(child), found: Vec::new() };
        unsafe { EnumWindows(Some(visit), (&raw mut search) as LPARAM) };
        search.found
    }

    // Chromium uses WS_MAXIMIZE to suppress resize edges. Redirected windows
    // (WPF) instead turn the next WM_SIZE into a maximized client layout,
    // including its internal frame, so they must not receive that hint.
    fn embedded_style(style: u32, ex_style: u32, menu: bool) -> u32 {
        let frameless = style & !(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_MAXIMIZE);
        if menu { frameless | WS_POPUP | WS_CLIPCHILDREN | WS_CLIPSIBLINGS }
        else {
            let maximize = if ex_style & WS_EX_NOREDIRECTIONBITMAP != 0 { WS_MAXIMIZE } else { 0 };
            frameless | WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS | maximize
        }
    }

    #[cfg(test)]
    mod style_tests {
        use super::*;

        #[test]
        fn redirected_children_do_not_regain_maximized_state() {
            for state in [0, WS_MAXIMIZE, WS_MINIMIZE] {
                let style = embedded_style(WS_OVERLAPPEDWINDOW | WS_VISIBLE | state, WS_EX_APPWINDOW | WS_EX_WINDOWEDGE, false);
                assert_eq!(style & WS_MAXIMIZE, 0);
                assert_ne!(style & WS_CHILD, 0);
                assert_eq!(style & (WS_CAPTION | WS_THICKFRAME | WS_POPUP), 0);
                assert_ne!(style & WS_VISIBLE, 0);
            }
        }

        #[test]
        fn composed_children_keep_the_maximized_edge_hint() {
            let style = embedded_style(WS_OVERLAPPEDWINDOW | WS_VISIBLE, WS_EX_NOREDIRECTIONBITMAP, false);
            assert_eq!(style & (WS_CHILD | WS_MAXIMIZE), WS_CHILD | WS_MAXIMIZE);
            assert_eq!(style & (WS_CAPTION | WS_THICKFRAME | WS_POPUP), 0);
        }

        #[test]
        fn menu_windows_remain_unmaximized_popups() {
            for ex_style in [0, WS_EX_NOREDIRECTIONBITMAP] {
                let style = embedded_style(WS_OVERLAPPEDWINDOW | WS_MAXIMIZE, ex_style, true);
                assert_ne!(style & WS_POPUP, 0);
                assert_eq!(style & (WS_CHILD | WS_MAXIMIZE | WS_CAPTION | WS_THICKFRAME), 0);
            }
        }
    }
    /// Move the program's top-level window into a new container in `host`.
    /// A window with a Win32 menu bar (Unity) keeps it: a child window cannot
    /// have one, so it stays a captionless popup inside the container.
    ///
    /// Restyling and reparenting send messages to the program. A popup's
    /// program may be busy for a minute (Unity loading a project): its calls
    /// run on a background thread, and the window appears when they are done.
    async fn embed(hwnd: HWND, host: HWND, menu: bool, cx: &mut gpui::AsyncWindowContext) -> Embedded {
        let (container, style, ex_style) = unsafe {
            let container = container::create(host);
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            // Herdr's flip-model swap chain covers child windows that draw
            // into a redirection surface (WPF, as in Fork). A layered
            // container gets its own DWM surface above it. Programs with
            // their own composition (Chromium) need none.
            if ex_style as u32 & WS_EX_NOREDIRECTIONBITMAP == 0 {
                SetWindowLongPtrW(container, GWL_EXSTYLE, GetWindowLongPtrW(container, GWL_EXSTYLE) | WS_EX_LAYERED as isize);
                SetLayeredWindowAttributes(container, 0, 255, LWA_ALPHA);
            }
            (container, style, ex_style)
        };
        let (window, parent) = (hwnd as usize, container as usize);
        let reparent = move || unsafe {
            let (hwnd, container) = (window as HWND, parent as HWND);
            if IsIconic(hwnd) != 0 || IsZoomed(hwnd) != 0 { ShowWindow(hwnd, SW_RESTORE); }
            let child_style = embedded_style(style as u32, ex_style as u32, menu);
            SetWindowLongPtrW(hwnd, GWL_STYLE, child_style as isize);
            let child_ex = ex_style as u32 & !(WS_EX_APPWINDOW | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_DLGMODALFRAME | WS_EX_NOPARENTNOTIFY | WS_EX_TOPMOST);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, child_ex as isize);
            SetParent(hwnd, container);
            SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        };
        if menu { cx.background_executor().spawn(async move { reparent() }).await } else { reparent() }
        focus::adopt(host, container, hwnd, menu);
        Embedded { child: hwnd, container, style, ex_style, crop: Crop::default(), applied: None, popup: menu, hidden: Vec::new(), adopted: std::time::SystemTime::now() }
    }

    /// Give the container the pane's latest geometry, visibility and holes.
    ///
    /// Runs outside App updates, and makes its native calls without any
    /// borrow: SetFocus and SetWindowPos deliver messages to Herdr's own
    /// window at once, which can draw a frame that reads this state again.
    pub(super) fn apply(state: &State) {
        let (child, container, crop, rect, visible, holes, give, hide, reshow, popup) = {
            let mut app = state.borrow_mut();
            app.apply_pending = false;
            if !app.needs_apply() { return; }
            let (rect, visible, holes) = (app.rect.unwrap(), app.visible, app.holes.clone());
            let give = visible && app.focus_until.take().is_some_and(|until| std::time::Instant::now() <= until);
            app.status = if visible { "Shown.".into() } else { "Hidden while its pane is covered.".into() };
            let embedded = app.embedded.as_mut().unwrap();
            let was_visible = embedded.applied.as_ref().map(|(_, v, _)| *v);
            embedded.applied = Some((rect, visible, holes.clone()));
            // Unity's floating windows go and come back with its pane.
            let hide = embedded.popup && !visible && was_visible != Some(false);
            let reshow = if visible { std::mem::take(&mut embedded.hidden) } else { Vec::new() };
            (embedded.child, embedded.container, embedded.crop, rect, visible, holes, give, hide, reshow, embedded.popup)
        };
        for hwnd in reshow { unsafe { ShowWindowAsync(hwnd, SW_SHOWNOACTIVATE) }; }
        if hide {
            let floating = floating_windows(child);
            for &hwnd in &floating { unsafe { ShowWindowAsync(hwnd, SW_HIDE) }; }
            if let Some(e) = state.borrow_mut().embedded.as_mut() { e.hidden.extend(floating); }
        }
        let width = rect[2].max(1);
        let height = rect[3].max(1);
        unsafe {
            if !visible { focus::release(container, child); }
            let show = if visible { SWP_SHOWWINDOW } else { SWP_HIDEWINDOW };
            SetWindowPos(container, HWND_TOP, rect[0], rect[1], width, height, SWP_NOACTIVATE | show);
        }
        super::super::win32::set_holes(container, width, height, &holes);
        let [x, y, w, h] = child_rect(width, height, crop);
        // A popup's program gets the move posted: it may be busy.
        let posted = if popup { SWP_ASYNCWINDOWPOS } else { 0 };
        unsafe { SetWindowPos(child, std::ptr::null_mut(), x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE | posted) };
        if give { focus::give(child); }
    }

    /// The window's frame: what lies outside its client area, except a menu
    /// bar. Everything the program draws stays, including VS Code's title bar
    /// and the few pixels at its edges where it reports resize borders. A
    /// resize from there is undone by the watcher. Runs off the window thread.
    fn measure(hwnd: HWND) -> Crop {
        unsafe {
            let window = screen_rect(hwnd);
            let mut client = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            GetClientRect(hwnd, &mut client);
            let mut origin = POINT { x: 0, y: 0 };
            ClientToScreen(hwnd, &mut origin);
            let mut bar: MENUBARINFO = std::mem::zeroed();
            bar.cbSize = size_of::<MENUBARINFO>() as u32;
            let top = if GetMenuBarInfo(hwnd, OBJID_MENU, 0, &mut bar) != 0 && bar.rcBar.bottom > bar.rcBar.top { bar.rcBar.top } else { origin.y };
            Crop {
                left: origin.x - window.left,
                top: top - window.top,
                right: window.right - (origin.x + client.right),
                bottom: window.bottom - (origin.y + client.bottom),
            }
        }
    }

    /// Herdr's container windows for adopted windows.
    mod container {
        use super::*;
        use std::sync::Once;

        const CLASS: &str = "HerdrNativeAppHost";

        fn class_name() -> Vec<u16> { CLASS.encode_utf16().chain([0]).collect() }

        pub fn create(host: HWND) -> HWND {
            static REGISTER: Once = Once::new();
            let name = class_name();
            unsafe {
                let instance = GetModuleHandleW(std::ptr::null());
                REGISTER.call_once(|| {
                    let class = WNDCLASSEXW {
                        cbSize: size_of::<WNDCLASSEXW>() as u32,
                        lpfnWndProc: Some(proc),
                        hInstance: instance,
                        lpszClassName: name.as_ptr(),
                        ..std::mem::zeroed()
                    };
                    RegisterClassExW(&class);
                });
                CreateWindowExW(0, name.as_ptr(), std::ptr::null(), WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                    0, 0, 1, 1, host, std::ptr::null_mut(), instance, std::ptr::null())
            }
        }

        unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
            match msg {
                // Keyboard focus passes through to the adopted window.
                WM_SETFOCUS => {
                    let child = unsafe { GetWindow(hwnd, GW_CHILD) };
                    if !child.is_null() { unsafe { SetFocus(child) }; }
                    0
                }
                // The adopted window paints everything; no flash of a background.
                WM_ERASEBKGND => 1,
                _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
            }
        }
    }

    /// Keyboard focus between Herdr and adopted windows.
    ///
    /// A Chromium window takes keyboard focus when its top-level window is
    /// activated, which a child window never is. Herdr's window is subclassed
    /// instead: a click on an adopted window (WM_PARENTNOTIFY) gives it focus,
    /// a click on Herdr's own surface takes focus back, and activating Herdr
    /// returns focus to the adopted window that had it. Reparenting attached
    /// both processes' input queues, so SetFocus works across them.
    ///
    /// A popup (Unity) shares no input queue with Herdr and takes the
    /// keyboard only as the foreground window. A low-level mouse hook on a
    /// thread of its own sees a press on it and asks Herdr's window to make it
    /// the foreground window; a click on Herdr's surface activates Herdr again.
    mod focus {
        use std::cell::{Cell, RefCell};
        use std::sync::Mutex;
        use windows_sys::Win32::{
            Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
            Graphics::Gdi::{CreateRectRgn, DeleteObject, GetWindowRgn, PtInRegion, ScreenToClient},
            System::LibraryLoader::GetModuleHandleW,
            UI::Input::KeyboardAndMouse::{GetFocus, SetFocus},
            UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            UI::WindowsAndMessaging::*,
        };

        const ID: usize = 0x4845_5244; // "HERD"
        /// Posted to a host: make the popup in wparam the foreground window.
        const FOCUS_POPUP: u32 = WM_APP + 0x4844;

        /// (host, container, popup) of every adopted popup, for the hook thread.
        static POPUPS: Mutex<Vec<(usize, usize, usize)>> = Mutex::new(Vec::new());
        static HOOK: std::sync::Once = std::sync::Once::new();

        thread_local! {
            /// (host, container, adopted window).
            static EMBEDDED: RefCell<Vec<(HWND, HWND, HWND)>> = const { RefCell::new(Vec::new()) };
            /// The adopted window that should have focus while Herdr is active.
            static ACTIVE: Cell<HWND> = const { Cell::new(std::ptr::null_mut()) };
        }

        pub fn adopt(host: HWND, container: HWND, hwnd: HWND, popup: bool) {
            let first = EMBEDDED.with_borrow_mut(|list| {
                let first = !list.iter().any(|&(h, _, _)| h == host);
                list.push((host, container, hwnd));
                first
            });
            if first { unsafe { SetWindowSubclass(host, Some(proc), ID, 0) }; }
            if popup {
                POPUPS.lock().unwrap().push((host as usize, container as usize, hwnd as usize));
                HOOK.call_once(|| { let _ = std::thread::Builder::new().name("native-app-mouse".into()).spawn(hook_thread); });
            }
        }

        fn is_popup(hwnd: HWND) -> bool {
            POPUPS.lock().unwrap().iter().any(|&(_, _, p)| p == hwnd as usize)
        }

        fn hook_thread() {
            unsafe {
                if SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), GetModuleHandleW(std::ptr::null()), 0).is_null() { return; }
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
            }
        }

        /// A press inside a shown popup's container, outside the holes cut for
        /// Herdr's overlays. No messages are sent: the hook must not wait.
        unsafe extern "system" fn mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
            // Also on release: the press activates Herdr's window after this.
            if code >= 0 && matches!(wparam as u32, WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN | WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP | WM_XBUTTONUP) {
                let point = unsafe { (*(lparam as *const MSLLHOOKSTRUCT)).pt };
                // Only where Herdr's window is the top one: no other window over it.
                let top = unsafe { ChildWindowFromPointEx(GetDesktopWindow(), point, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT) } as usize;
                let hit = POPUPS.lock().unwrap().iter().copied().find(|&(host, container, _)| host == top && unsafe { inside(container as HWND, point) });
                if let Some((host, _, popup)) = hit { unsafe { PostMessageW(host as HWND, FOCUS_POPUP, popup, 0) }; }
            }
            unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
        }

        unsafe fn inside(container: HWND, point: POINT) -> bool {
            unsafe {
                if IsWindowVisible(container) == 0 { return false; }
                let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
                GetWindowRect(container, &mut r);
                if point.x < r.left || point.x >= r.right || point.y < r.top || point.y >= r.bottom { return false; }
                let region = CreateRectRgn(0, 0, 0, 0);
                let shaped = GetWindowRgn(container, region) != 0;
                let ok = !shaped || PtInRegion(region, point.x - r.left, point.y - r.top) != 0;
                DeleteObject(region);
                ok
            }
        }

        pub fn forget(container: HWND) {
            EMBEDDED.with_borrow_mut(|list| {
                if let Some(&(_, _, hwnd)) = list.iter().find(|&&(_, c, _)| c == container) {
                    if ACTIVE.get() == hwnd { ACTIVE.set(std::ptr::null_mut()); }
                }
                list.retain(|&(_, c, _)| c != container);
            });
            POPUPS.lock().unwrap().retain(|&(_, c, _)| c != container as usize);
        }

        /// The window is hidden: its typing goes back to Herdr.
        pub fn release(container: HWND, hwnd: HWND) {
            if ACTIVE.get() == hwnd { ACTIVE.set(std::ptr::null_mut()); }
            let host = unsafe { GetParent(container) };
            // A hidden popup that had the keyboard gives it back to Herdr.
            if unsafe { GetForegroundWindow() } == hwnd { unsafe { SetForegroundWindow(host) }; }
            let focus = unsafe { GetFocus() };
            if focus == container || focus == hwnd || unsafe { IsChild(container, focus) } != 0 {
                unsafe { SetFocus(host) };
            }
        }

        pub fn give(hwnd: HWND) {
            if is_popup(hwnd) { unsafe { SetForegroundWindow(hwnd) }; return; }
            ACTIVE.set(hwnd);
            unsafe { SetFocus(hwnd) };
        }

        fn adopted_at(host: HWND, point: POINT) -> Option<HWND> {
            let child = unsafe { ChildWindowFromPointEx(host, point, CWP_SKIPINVISIBLE) };
            EMBEDDED.with_borrow(|list| list.iter().find(|&&(h, c, _)| h == host && c == child).map(|&(_, _, w)| w))
        }

        unsafe extern "system" fn proc(host: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _: usize, _: usize) -> LRESULT {
            if msg == FOCUS_POPUP {
                if is_popup(wparam as HWND) { unsafe { SetForegroundWindow(wparam as HWND) }; }
                return 0;
            }
            match msg {
                WM_PARENTNOTIFY => {
                    let event = (wparam & 0xffff) as u32;
                    if matches!(event, WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN | WM_POINTERDOWN) {
                        let mut point = POINT { x: (lparam & 0xffff) as i16 as i32, y: ((lparam >> 16) & 0xffff) as i16 as i32 };
                        // Pointer notifications carry screen coordinates; mouse ones the host's client coordinates.
                        if event == WM_POINTERDOWN { unsafe { ScreenToClient(host, &mut point) }; }
                        if let Some(hwnd) = adopted_at(host, point) { give(hwnd); }
                    }
                }
                WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN | WM_NCLBUTTONDOWN => {
                    // Herdr's own surface: its keys go to Herdr again.
                    ACTIVE.set(std::ptr::null_mut());
                    if unsafe { GetFocus() } != host { unsafe { SetFocus(host) }; }
                }
                WM_SETFOCUS => {
                    let result = unsafe { DefSubclassProc(host, msg, wparam, lparam) };
                    let active = ACTIVE.get();
                    if !active.is_null() && unsafe { IsWindow(active) } != 0 && unsafe { IsWindowVisible(active) } != 0 {
                        unsafe { SetFocus(active) };
                    }
                    return result;
                }
                WM_NCDESTROY => {
                    EMBEDDED.with_borrow_mut(|list| list.retain(|&(h, _, _)| h != host));
                    unsafe { RemoveWindowSubclass(host, Some(proc), ID) };
                }
                _ => {}
            }
            unsafe { DefSubclassProc(host, msg, wparam, lparam) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Description, class_matches, title_shows};
    use gpui_shell::ComponentDataValue as V;

    fn object(fields: &[(&str, V)]) -> V {
        V::Object(fields.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect())
    }

    fn strings(items: &[&str]) -> V {
        V::Array(items.iter().map(|s| V::String((*s).to_owned())).collect())
    }

    #[test]
    fn a_launch_description_comes_from_plain_data() {
        let description = Description::parse(&object(&[
            ("program", strings(&["C:/a/Code.exe"])),
            ("args", strings(&["--new-window", "C:/dev/app"])),
            ("class", V::String("Chrome_WidgetWin_1".into())),
            ("title", V::String("app".into())),
            ("ownProcess", V::Boolean(true)),
            ("menuWindow", V::Boolean(true)),
            ("once", V::Boolean(true)),
            ("wait", V::Number(1800.0)),
            ("missing", V::String("VS Code is not installed".into())),
        ])).unwrap();
        assert_eq!(description.program, ["C:/a/Code.exe"]);
        assert_eq!(description.args, ["--new-window", "C:/dev/app"]);
        assert!(description.own_process && description.menu_window && description.once);
        assert_eq!(description.wait, 1800.0);

        let minimal = Description::parse(&object(&[("program", strings(&["a.exe"])), ("class", V::String("C".into()))])).unwrap();
        assert!(minimal.args.is_empty() && minimal.title.is_empty() && !minimal.own_process && !minimal.once && !minimal.menu_window);
        assert_eq!(minimal.wait, 20.0);

        let error = |fields: &[(&str, V)]| Description::parse(&object(fields)).unwrap_err().to_string();
        assert!(error(&[("class", V::String("C".into()))]).contains("program"));
        assert!(error(&[("program", strings(&[" "])), ("class", V::String("C".into()))]).contains("names no program"));
        assert!(error(&[("program", strings(&["a.exe"])), ("class", V::String(String::new()))]).contains("window class"));
        assert!(error(&[("program", strings(&["a.exe"])), ("class", V::String("C".into())), ("wait", V::Number(0.0))]).contains("wait"));
        // A misspelled field is an error, not a silent default.
        assert!(error(&[("program", strings(&["a.exe"])), ("class", V::String("C".into())), ("own_process", V::Boolean(true))]).contains("own_process"));
        assert!(Description::parse(&V::Null).is_err());
    }

    #[test]
    fn the_first_program_path_that_exists_runs() {
        let dir = std::env::temp_dir().join(format!("herdr-native-app-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let present = dir.join("present.exe");
        std::fs::write(&present, b"").unwrap();
        let path = |p: &std::path::Path| p.to_string_lossy().into_owned();
        let described = |program: Vec<String>, missing: Option<&str>| Description {
            program, args: Vec::new(), class: "C".into(), title: String::new(), own_process: false, once: false,
            menu_window: false, wait: 20.0, missing: missing.map(str::to_owned),
        };
        let absent = path(&dir.join("absent.exe"));
        assert_eq!(described(vec![absent.clone(), path(&present), path(&dir)], None).program().unwrap(), present);
        // A folder is no program.
        assert!(described(vec![path(&dir)], None).program().unwrap_err().to_string().contains("None of these programs exists"));
        assert_eq!(described(vec![absent], Some("Fork is not installed")).program().unwrap_err().to_string(), "Fork is not installed");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn classes_match_exactly_or_by_prefix() {
        assert!(class_matches("Chrome_WidgetWin_1", "Chrome_WidgetWin_1"));
        assert!(!class_matches("Chrome_WidgetWin_1", "Chrome_WidgetWin_10"));
        assert!(class_matches("HwndWrapper[Fork.exe;*", "HwndWrapper[Fork.exe;;f99ed41f-8634-42e2-ab0d-34b527cb1e44]"));
        assert!(!class_matches("HwndWrapper[Fork.exe;*", "HwndWrapper[Other.exe;;f99ed41f]"));
    }

    #[test]
    fn the_shipped_mods_call_only_methods_the_state_has() {
        let registry = crate::browser::components();
        let state = registry.states().find(|s| s.export() == "NativeAppState").expect("NativeAppState is registered");
        let methods: Vec<&str> = state.methods().iter().map(|m| m.name()).collect();
        let call = fancy_regex::Regex::new(r"\bapp\??\.(\w+)\(").unwrap();
        for (name, source) in [
            ("vscode", include_str!("../../defaults/mods/vscode/main.js")),
            ("fork", include_str!("../../defaults/mods/fork/main.js")),
            ("unity", include_str!("../../defaults/mods/unity/main.js")),
        ] {
            let called: Vec<&str> = call.captures_iter(source).map(|c| c.unwrap().get(1).unwrap().as_str()).collect();
            assert!(called.contains(&"open") && called.contains(&"reopen"), "{name}: {called:?}");
            for method in called {
                assert!(methods.contains(&method), "the {name} mod calls NativeAppState's {method}(), which it lacks");
            }
        }
    }

    #[test]
    fn a_title_shows_a_target_as_one_of_its_parts() {
        assert!(title_shows("main.rs - app - Visual Studio Code", "app"));
        assert!(title_shows("main.rs - app [WSL: Ubuntu] - Visual Studio Code", "app"));
        assert!(title_shows("Game - Win64 - Unity 6000.6.6f1", "Game"));
        assert!(!title_shows("main.rs - my-app - Visual Studio Code", "app"));
        assert!(!title_shows("app2 - Visual Studio Code", "app"));
        assert!(!title_shows("anything", ""));
    }
}
