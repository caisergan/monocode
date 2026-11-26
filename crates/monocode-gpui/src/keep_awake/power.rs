//! IOPMLib power assertions that keep the Mac (and optionally the display)
//! awake, and IOPowerSources' battery reading. macOS drops an assertion when
//! its process exits, so a crash never leaves the Mac held awake.
//!
//! Tests and other platforms use a stand-in that only tracks what it would
//! hold, so running the suite never blocks the machine's sleep.

/// What powerd is asked to hold for this app.
#[derive(Default)]
pub(crate) struct Assertions {
    system: Option<u32>,
    display: Option<u32>,
}

impl Assertions {
    /// Take or release each assertion so exactly `system` and `display` are held.
    pub(crate) fn sync(&mut self, system: bool, display: bool) {
        set(&mut self.system, system, Kind::System);
        set(&mut self.display, display && system, Kind::Display);
    }
    pub(crate) fn holds_system(&self) -> bool {
        self.system.is_some()
    }
    pub(crate) fn holds_display(&self) -> bool {
        self.display.is_some()
    }
    /// Every assertion this app asked for is still known to powerd.
    pub(crate) fn verified(&self) -> bool {
        [self.system, self.display]
            .into_iter()
            .flatten()
            .all(backend::alive)
    }
}

impl Drop for Assertions {
    fn drop(&mut self) {
        self.sync(false, false);
    }
}

#[derive(Clone, Copy)]
enum Kind {
    System,
    Display,
}

fn set(slot: &mut Option<u32>, on: bool, kind: Kind) {
    match (*slot, on) {
        (None, true) => *slot = backend::create(kind),
        (Some(id), false) => {
            backend::release(id);
            *slot = None;
        }
        _ => {}
    }
}

/// The power source right now.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Battery {
    pub on_battery: bool,
    /// The internal battery's charge, when the Mac has one.
    pub percent: Option<u8>,
}

pub(crate) fn battery() -> Battery {
    backend::battery()
}

#[cfg(all(target_os = "macos", not(test)))]
mod backend {
    use super::{Battery, Kind};
    use objc2_foundation::NSString;
    use std::ffi::c_void;

    type CFTypeRef = *const c_void;
    /// kIOPMAssertionLevelOn.
    const LEVEL_ON: u32 = 255;
    /// kCFNumberSInt32Type.
    const SINT32: isize = 3;

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPMAssertionCreateWithName(
            kind: CFTypeRef,
            level: u32,
            name: CFTypeRef,
            id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
        fn IOPMAssertionCopyProperties(id: u32) -> CFTypeRef;
        fn IOPSCopyPowerSourcesInfo() -> CFTypeRef;
        fn IOPSCopyPowerSourcesList(blob: CFTypeRef) -> CFTypeRef;
        fn IOPSGetPowerSourceDescription(blob: CFTypeRef, source: CFTypeRef) -> CFTypeRef;
        fn IOPSGetProvidingPowerSourceType(blob: CFTypeRef) -> CFTypeRef;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: CFTypeRef);
        fn CFEqual(a: CFTypeRef, b: CFTypeRef) -> u8;
        fn CFArrayGetCount(array: CFTypeRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CFTypeRef, index: isize) -> CFTypeRef;
        fn CFDictionaryGetValue(dict: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
        fn CFNumberGetValue(number: CFTypeRef, kind: isize, out: *mut c_void) -> u8;
    }

    /// NSString is toll-free bridged to CFString.
    fn cf(text: &NSString) -> CFTypeRef {
        text as *const NSString as CFTypeRef
    }

    pub(super) fn create(kind: Kind) -> Option<u32> {
        let (assertion, name) = match kind {
            Kind::System => (
                "PreventUserIdleSystemSleep",
                "MonoCode is keeping the Mac awake",
            ),
            Kind::Display => (
                "PreventUserIdleDisplaySleep",
                "MonoCode is keeping the display on",
            ),
        };
        let (assertion, name) = (NSString::from_str(assertion), NSString::from_str(name));
        let mut id = 0u32;
        // SAFETY: both strings outlive the call and `id` is a valid out pointer.
        let status =
            unsafe { IOPMAssertionCreateWithName(cf(&assertion), LEVEL_ON, cf(&name), &mut id) };
        (status == 0).then_some(id)
    }

    pub(super) fn release(id: u32) {
        // SAFETY: `id` came from IOPMAssertionCreateWithName and is released once.
        unsafe {
            IOPMAssertionRelease(id);
        }
    }

    pub(super) fn alive(id: u32) -> bool {
        // SAFETY: a copy rule result, released when present.
        unsafe {
            let properties = IOPMAssertionCopyProperties(id);
            if properties.is_null() {
                return false;
            }
            CFRelease(properties);
            true
        }
    }

    pub(super) fn battery() -> Battery {
        // SAFETY: copy-rule results are released; get-rule results are only
        // read while their owner is alive.
        unsafe {
            let blob = IOPSCopyPowerSourcesInfo();
            if blob.is_null() {
                return Battery::default();
            }
            let providing = IOPSGetProvidingPowerSourceType(blob);
            let on_battery = !providing.is_null()
                && CFEqual(providing, cf(&NSString::from_str("Battery Power"))) != 0;
            let mut percent = None;
            let list = IOPSCopyPowerSourcesList(blob);
            if !list.is_null() {
                let (current, max, kind) = (
                    NSString::from_str("Current Capacity"),
                    NSString::from_str("Max Capacity"),
                    NSString::from_str("Type"),
                );
                let internal = NSString::from_str("InternalBattery");
                for ix in 0..CFArrayGetCount(list) {
                    let description =
                        IOPSGetPowerSourceDescription(blob, CFArrayGetValueAtIndex(list, ix));
                    if description.is_null() {
                        continue;
                    }
                    let source = CFDictionaryGetValue(description, cf(&kind));
                    if source.is_null() || CFEqual(source, cf(&internal)) == 0 {
                        continue;
                    }
                    let read = |key: &NSString| {
                        let number = CFDictionaryGetValue(description, cf(key));
                        let mut value = 0i32;
                        (!number.is_null()
                            && CFNumberGetValue(number, SINT32, &mut value as *mut i32 as _) != 0)
                            .then_some(value)
                    };
                    if let (Some(now), Some(full)) = (read(&current), read(&max))
                        && full > 0
                    {
                        percent = Some((now * 100 / full).clamp(0, 100) as u8);
                    }
                    break;
                }
                CFRelease(list);
            }
            CFRelease(blob);
            Battery {
                on_battery,
                percent,
            }
        }
    }
}

#[cfg(not(all(target_os = "macos", not(test))))]
mod backend {
    use super::{Battery, Kind};
    use std::sync::atomic::{AtomicU32, Ordering};

    static NEXT: AtomicU32 = AtomicU32::new(1);

    pub(super) fn create(_: Kind) -> Option<u32> {
        Some(NEXT.fetch_add(1, Ordering::Relaxed))
    }
    pub(super) fn release(_: u32) {}
    pub(super) fn alive(_: u32) -> bool {
        true
    }
    pub(super) fn battery() -> Battery {
        Battery::default()
    }
}

/// `pmset -g`'s idle timers, in minutes; zero means never.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Schedule {
    pub display: Option<u32>,
    pub system: Option<u32>,
}

/// Read the active power profile's display and system sleep timers.
pub(crate) fn schedule() -> Schedule {
    if !cfg!(target_os = "macos") {
        return Schedule::default();
    }
    std::process::Command::new("/usr/bin/pmset")
        .arg("-g")
        .output()
        .ok()
        .map(|out| parse_schedule(&String::from_utf8_lossy(&out.stdout)))
        .unwrap_or_default()
}

pub(crate) fn parse_schedule(text: &str) -> Schedule {
    let mut schedule = Schedule::default();
    for line in text.lines() {
        let mut words = line.split_whitespace();
        let (Some(key), Some(value)) = (words.next(), words.next()) else {
            continue;
        };
        let Ok(minutes) = value.parse::<u32>() else {
            continue;
        };
        match key {
            "displaysleep" => schedule.display = Some(minutes),
            "sleep" => schedule.system = Some(minutes),
            _ => {}
        }
    }
    schedule
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_is_only_held_alongside_the_system() {
        let mut held = Assertions::default();
        held.sync(false, true);
        assert!(!held.holds_system() && !held.holds_display());
        held.sync(true, true);
        assert!(held.holds_system() && held.holds_display());
        held.sync(true, false);
        assert!(held.holds_system() && !held.holds_display());
        held.sync(false, false);
        assert!(!held.holds_system());
    }

    #[test]
    fn pmset_timers_skip_disk_sleep_and_keep_annotations() {
        let text = "System-wide power settings:\nCurrently in use:\n standby              1\n \
                    disksleep            10\n sleep                1 (sleep prevented by MonoCode)\n \
                    displaysleep         10\n";
        assert_eq!(
            parse_schedule(text),
            Schedule {
                display: Some(10),
                system: Some(1)
            }
        );
    }
}
