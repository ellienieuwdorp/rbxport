//! The main window's frame rate on macOS.
//!
//! WebKit holds a page's rendering updates, and with them
//! `requestAnimationFrame`, near 60 a second unless told otherwise: its
//! "Prefer Page Rendering Updates near 60fps" preference is on by default. On
//! a 120 Hz ProMotion display that halves the scrolling waveform's frames, and
//! next to rekordbox it looks it. Neither Tauri nor wry exposes the
//! preference, so it is turned off here through WebKit's feature list once the
//! webview exists. Measured on a 120 Hz built-in display: a frame every 8 ms
//! instead of every 17. A 60 Hz monitor still gets 60.
//!
//! The feature list is private API. That is acceptable for an app shipped
//! outside the Mac App Store, but any Safari update can change it, so every
//! step is checked before it is taken, and anything missing leaves WebKit's
//! default in place with a warning rather than stopping the app.

#![allow(unsafe_code, reason = "WebKit's feature list is reached through the Objective-C runtime")]

use std::panic::AssertUnwindSafe;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2::{msg_send, sel};
use objc2_foundation::{NSArray, NSString};

/// WebKit's key for "Prefer Page Rendering Updates near 60fps".
const NEAR_60_FPS: &str = "PreferPageRenderingUpdatesNear60FPSEnabled";

/// Lets `window`'s webview draw at the display's refresh rate.
pub fn follow_display(window: &tauri::WebviewWindow) {
    let scheduled = window.with_webview(|webview| {
        let wk_webview = webview.inner().cast::<AnyObject>();
        // SAFETY: `with_webview` runs this on the main thread, and `inner` is
        // the window's live `WKWebView`. Called inside `catch` because an
        // exception thrown by private API would otherwise abort the process.
        let outcome = objc2::exception::catch(AssertUnwindSafe(|| unsafe { disable_near_60_fps(wk_webview) }));
        match outcome {
            Ok(Ok(())) => tracing::info!("webview frames follow the display's refresh rate"),
            Ok(Err(missing)) => {
                tracing::warn!(missing, "webview frames stay near 60 a second: WebKit lacks what turns that off");
            }
            Err(exception) => {
                tracing::warn!(exception = ?exception, "webview frames stay near 60 a second: WebKit threw");
            }
        }
    });
    if let Err(error) = scheduled {
        tracing::warn!(%error, "webview frames stay near 60 a second: no webview to change");
    }
}

/// Turns WebKit's near-60fps preference off for `webview`, or names the first
/// thing it found missing.
///
/// # Safety
/// `webview` must be null or a live `WKWebView`, and this must run on the
/// main thread.
unsafe fn disable_near_60_fps(webview: *mut AnyObject) -> Result<(), &'static str> {
    // SAFETY: the caller hands over null or a live `WKWebView`.
    let webview = unsafe { webview.as_ref() }.ok_or("WKWebView")?;
    // SAFETY: `configuration` and `preferences` are public `WKWebView` and
    // `WKWebViewConfiguration` properties returning objects.
    let configuration: Option<Retained<AnyObject>> = unsafe { msg_send![webview, configuration] };
    let configuration = configuration.ok_or("WKWebView.configuration")?;
    // SAFETY: as above.
    let preferences: Option<Retained<AnyObject>> = unsafe { msg_send![&*configuration, preferences] };
    let preferences = preferences.ok_or("WKWebViewConfiguration.preferences")?;

    let class = AnyClass::get(c"WKPreferences").ok_or("WKPreferences")?;
    if !class.metaclass().responds_to(sel!(_features)) {
        return Err("+[WKPreferences _features]");
    }
    if !preferences.class().responds_to(sel!(_setEnabled:forFeature:)) {
        return Err("-[WKPreferences _setEnabled:forFeature:]");
    }
    // SAFETY: the class answers `_features`, which returns an array of
    // `_WKFeature`s.
    let features: Option<Retained<NSArray>> = unsafe { msg_send![class, _features] };
    let feature = features
        .ok_or("+[WKPreferences _features]")?
        .iter()
        .find(|feature| {
            if !feature.class().responds_to(sel!(key)) {
                return false;
            }
            // SAFETY: the feature answers `key`, which returns a string.
            let key: Option<Retained<NSString>> = unsafe { msg_send![&**feature, key] };
            key.is_some_and(|key| key.to_string() == NEAR_60_FPS)
        })
        .ok_or(NEAR_60_FPS)?;
    // SAFETY: the preferences answer `_setEnabled:forFeature:`, which takes a
    // BOOL and one of the `_WKFeature`s `_features` returned.
    let () = unsafe { msg_send![&*preferences, _setEnabled: false, forFeature: &*feature] };
    Ok(())
}
