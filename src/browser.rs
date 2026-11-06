//! A native HTTP(S) view for trusted mods. Web pages get no Herdr IPC bridge.
mod policy;
#[cfg(target_os = "linux")]
mod linux;

use gpui::{AnyElement, App, Bounds, IntoElement, ParentElement, Pixels, Styled, Window, WindowId, canvas, div};
use gpui_shell::{ArgumentDescriptor, ArgumentSchema, ComponentArgument, ComponentDataValue, ComponentDescriptor, ComponentMaterializer, ComponentPayload, ComponentRegistry, ConstructorDescriptor, FrozenComponentRegistry, MaterializeRequest, StateDescriptor, StateMethodDescriptor, COMPONENT_REGISTRY_API_VERSION};
use std::{cell::RefCell, rc::{Rc, Weak}, sync::Arc};

type State = Rc<RefCell<Browser>>;
thread_local! {
    static VIEWS: RefCell<Vec<Weak<RefCell<Browser>>>> = const { RefCell::new(Vec::new()) };
}

struct Browser {
    window: WindowId,
    url: String,
    native: Option<wry::WebView>,
    error: Option<String>,
    drawn: bool,
    unclipped: bool,
    visible: bool,
}

impl Drop for Browser {
    fn drop(&mut self) {
        if let Some(view) = &self.native {
            let _ = view.set_visible(false);
        }
    }
}

impl Browser {
    fn create(&mut self, window: &mut Window, cx: &mut App) -> anyhow::Result<()> {
        if self.native.is_some() || self.error.is_some() { return Ok(()); }
        let builder = wry::WebViewBuilder::new()
            .with_url(&self.url)
            .with_visible(false)
            .with_navigation_handler(|url| policy::allows_navigation(&url))
            // No popups, downloads, custom protocols, initialization scripts or native IPC.
            .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
            .with_download_started_handler(|_, _| false);
        #[cfg(target_os = "linux")]
        let view = linux::build(builder, window, cx)?;
        #[cfg(not(target_os = "linux"))]
        let view = builder.build_as_child(window)?;
        self.native = Some(view);
        Ok(())
    }

    fn layout(&mut self, bounds: Bounds<Pixels>, window: &Window) {
        self.drawn = true;
        let clipped = bounds.intersect(&window.content_mask().bounds);
        self.unclipped = clipped == bounds && bounds.size.width > gpui::px(0.) && bounds.size.height > gpui::px(0.);
        let Some(view) = &self.native else { return };
        // GTK expects physical pixels. WebView2 and WKWebView use logical coordinates.
        let x = f64::from(f32::from(bounds.origin.x));
        let y = f64::from(f32::from(bounds.origin.y));
        let width = f64::from(f32::from(bounds.size.width));
        let height = f64::from(f32::from(bounds.size.height));
        let rect = if cfg!(target_os = "linux") {
            let scale = f64::from(window.scale_factor());
            wry::Rect {
                position: wry::dpi::PhysicalPosition::new(x * scale, y * scale).into(),
                size: wry::dpi::PhysicalSize::new(width * scale, height * scale).into(),
            }
        } else {
            wry::Rect {
                position: wry::dpi::LogicalPosition::new(x, y).into(),
                size: wry::dpi::LogicalSize::new(width, height).into(),
            }
        };
        if let Err(error) = view.set_bounds(rect) {
            self.error = Some(error.to_string());
            self.unclipped = false;
        }
    }

    fn show(&mut self, overlay: bool) {
        let show = policy::should_show(self.drawn, self.unclipped, overlay) && self.error.is_none();
        if show == self.visible { return; }
        if let Some(view) = &self.native {
            match view.set_visible(show) {
                Ok(()) => self.visible = show,
                Err(error) => self.error = Some(error.to_string()),
            }
        }
    }
}

/// Reset the per-window paint census; inactive tabs keep their page, hidden.
pub fn begin_frame(window: WindowId) {
    VIEWS.with_borrow_mut(|views| {
        views.retain(|weak| {
            let Some(view) = weak.upgrade() else { return false };
            let mut view = view.borrow_mut();
            if view.window == window { view.drawn = false; }
            true
        });
    });
}

/// Native child windows cannot be covered by GPUI overlays. Hide them while an
/// overlay is up, and whenever their element was absent or partly clipped.
pub fn end_frame(overlay: bool) -> impl IntoElement {
    canvas(|_, _, _| (), move |_, _, window, _| {
        VIEWS.with_borrow(|views| {
            for view in views.iter().filter_map(Weak::upgrade) {
                let mut view = view.borrow_mut();
                if view.window == window.window_id() { view.show(overlay); }
            }
        });
    })
}

struct BrowserElement;
impl ComponentMaterializer for BrowserElement {
    fn materialize(&self, mut request: MaterializeRequest<'_>) -> anyhow::Result<AnyElement> {
        let argument = request.payload().downcast_ref::<ComponentArgument>().unwrap().clone();
        let state = request.with_state::<State, _>(&argument, Clone::clone)?;
        request.with_window_app(|window, cx| {
            let mut browser = state.borrow_mut();
            if let Err(error) = browser.create(window, cx) { browser.error = Some(error.to_string()); }
            Ok(())
        })?;
        let message = state.borrow().error.clone().unwrap_or_else(|| "Browser hidden while a Herdr overlay is open.".into());
        let element = div().relative().size_full()
            .child(div().absolute().size_full().p(gpui::px(16.)).child(message))
            .child(canvas(move |bounds, window, _| state.borrow_mut().layout(bounds, window), |_, _, _, _| {}).size_full());
        request.finish(element)
    }
}

pub fn components() -> FrozenComponentRegistry {
    let mut registry = ComponentRegistry::new(COMPONENT_REGISTRY_API_VERSION, "herdr-browser").unwrap();
    registry.register_state(StateDescriptor::new(
        "BrowserState", "HerdrBrowserState", vec![ArgumentDescriptor::new("url", ArgumentSchema::String)],
        |args, window, _| {
            let ComponentArgument::String(url) = &args[0] else { unreachable!() };
            if !policy::allows_navigation(url) { return Err("Expected an HTTP(S) URL without credentials".into()); }
            let state = Rc::new(RefCell::new(Browser { window: window.window_id(), url: url.clone(), native: None, error: None, drawn: false, unclipped: false, visible: false }));
            VIEWS.with_borrow_mut(|views| views.push(Rc::downgrade(&state)));
            Ok(Box::new(state))
        },
    ).with_documentation("A retained native browser. Pages have no Herdr IPC. HTTP(S) only; no popups or downloads.")
    .with_methods(vec![
        StateMethodDescriptor::new::<State>("navigate", "(url: string): void", |state, args, _, _| {
            let Some(ComponentDataValue::String(url)) = args.first() else { anyhow::bail!("Expected a URL") };
            anyhow::ensure!(policy::allows_navigation(url), "Expected an HTTP(S) URL without credentials");
            let mut state = state.borrow_mut();
            if let Some(view) = &state.native { view.load_url(url)?; }
            state.url = url.clone();
            state.error = None;
            Ok(ComponentDataValue::Null)
        }),
        StateMethodDescriptor::new::<State>("reload", "(): void", |state, _, _, _| {
            let mut state = state.borrow_mut();
            if let Some(view) = &state.native { view.reload()?; }
            state.error = None;
            Ok(ComponentDataValue::Null)
        }),
        StateMethodDescriptor::new::<State>("back", "(): void", |state, _, _, _| {
            if let Some(view) = &state.borrow().native { view.evaluate_script("history.back()")?; }
            Ok(ComponentDataValue::Null)
        }),
        StateMethodDescriptor::new::<State>("url", "(): string", |state, _, _, _| {
            let state = state.borrow();
            let url = match &state.native { Some(view) => view.url()?, None => state.url.clone() };
            Ok(ComponentDataValue::String(url))
        }).with_readonly(true),
        StateMethodDescriptor::new::<State>("error", "(): string | null", |state, _, _, _| {
            Ok(state.borrow().error.clone().map(ComponentDataValue::String).unwrap_or(ComponentDataValue::Null))
        }).with_readonly(true),
    ])).unwrap();
    registry.register(ComponentDescriptor::new("Browser", Arc::new(BrowserElement))
        .with_documentation("Native browser element. Retain BrowserState in init and render Browser(state).")
        .with_constructors(vec![ConstructorDescriptor::new("Browser", vec![ArgumentDescriptor::new("state", ArgumentSchema::Entity("HerdrBrowserState"))], |args| Ok(ComponentPayload::new(args[0].clone())))])
        .with_methods(vec![])).unwrap();
    registry.freeze().unwrap()
}
