//! The keep-awake marks: a ring with an arc (the popover dial and the chip's
//! countdown ring) and the cup's rising steam. Painted on a canvas so they
//! follow the picked accent and the shared animation clock.
use crate::theme::{content, icon};
use gpui::{
    Bounds, Hsla, PathBuilder, Pixels, Point, Window, canvas, div, fill, point, prelude::*, px,
    size,
};
use std::f32::consts::{FRAC_PI_2, TAU};

/// An arc drawn clockwise from `start` (a fraction of a turn from twelve)
/// for `length` of a turn, with round ends and an optional end dot.
#[derive(Clone, Copy)]
pub(super) struct Arc {
    pub start: f32,
    pub length: f32,
    pub color: Hsla,
    pub dot: bool,
}

/// A `side`-pixel ring: a faint track, then `arc` on it.
pub(super) fn ring(side: f32, stroke: f32, track: Hsla, arc: Option<Arc>) -> impl IntoElement {
    div().size(px(side)).flex_shrink_0().child(
        canvas(
            |_, _, _| (),
            move |bounds, _, window, _| {
                let center = bounds.center();
                let radius = side / 2. - stroke / 2.;
                stroke_arc(window, center, radius, stroke, 0., 1., track);
                let Some(arc) = arc else {
                    return;
                };
                let length = arc.length.clamp(0., 1.);
                if length <= 0. {
                    return;
                }
                stroke_arc(window, center, radius, stroke, arc.start, length, arc.color);
                if length < 1. {
                    for at in [arc.start, arc.start + length] {
                        dot(window, at_angle(center, radius, at), stroke / 2., arc.color);
                    }
                }
                if arc.dot {
                    let end = at_angle(center, radius, arc.start + length);
                    dot(window, end, stroke * 1.2, arc.color);
                }
            },
        )
        .size_full(),
    )
}

fn at_angle(center: Point<Pixels>, radius: f32, turn: f32) -> Point<Pixels> {
    let angle = turn * TAU - FRAC_PI_2;
    center + point(px(radius * angle.cos()), px(radius * angle.sin()))
}

fn stroke_arc(
    window: &mut Window,
    center: Point<Pixels>,
    radius: f32,
    stroke: f32,
    start: f32,
    length: f32,
    color: Hsla,
) {
    let mut path = PathBuilder::stroke(px(stroke));
    let steps = ((length * 120.).ceil() as usize).max(2);
    for step in 0..=steps {
        let p = at_angle(center, radius, start + length * step as f32 / steps as f32);
        if step == 0 {
            path.move_to(p);
        } else {
            path.line_to(p);
        }
    }
    if length >= 1. {
        path.close();
    }
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
}

fn dot(window: &mut Window, at: Point<Pixels>, radius: f32, color: Hsla) {
    window.paint_quad(
        fill(
            Bounds::new(
                at - point(px(radius), px(radius)),
                size(px(radius * 2.), px(radius * 2.)),
            ),
            color,
        )
        .corner_radii(px(radius)),
    );
}

/// The `side`-pixel cup; `steam` is the shared clock's phase while sleep is
/// held, drawing two wisps that drift up and fade half a cycle apart.
pub(super) fn cup(side: f32, color: Hsla, steam: Option<f32>) -> impl IntoElement {
    div()
        .relative()
        .size(px(side))
        .flex_shrink_0()
        .child(icon("keep-awake-cup", side).text_color(color))
        .when_some(steam, |d, phase| {
            d.child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, _| {
                        // Phase zero, which reduced motion draws, shows one
                        // wisp fully risen and the other just appearing.
                        for (x, offset) in [(7.5, 0.35), (12., 0.85)] {
                            paint_wisp(window, bounds, side, x, (phase + offset) % 1., color);
                        }
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
        })
}

/// One wisp at `t` of its rise: it lifts about four grid units, stretches a
/// little and fades in then out.
fn paint_wisp(window: &mut Window, bounds: Bounds<Pixels>, side: f32, x: f32, t: f32, color: Hsla) {
    let opacity = if t < 0.25 {
        t / 0.25
    } else if t < 0.7 {
        1. - 0.3 * (t - 0.25) / 0.45
    } else {
        0.7 * (1. - (t - 0.7) / 0.3)
    };
    if opacity <= 0.01 {
        return;
    }
    let unit = side / 24.;
    // The cup's rim sits at 7.5 on the 24-unit grid.
    let lift = 1.6 - 3.6 * t;
    let stretch = 0.75 + 0.3 * t;
    let (bottom, height) = (6. + lift, 4.8 * stretch);
    let mut path = PathBuilder::stroke(px(1.75 * unit));
    let steps = 14;
    for step in 0..=steps {
        let f = step as f32 / steps as f32;
        let y = bottom - height * f;
        let sway = -0.85 * (f * TAU).sin();
        let p = bounds.origin + point(px((x + sway) * unit), px(y * unit));
        if step == 0 {
            path.move_to(p);
        } else {
            path.line_to(p);
        }
    }
    let mut stroke = color;
    stroke.a *= opacity;
    if let Ok(path) = path.build() {
        window.paint_path(path, stroke);
    }
}

/// The dial's ring track.
pub(super) fn track() -> Hsla {
    content(0.1)
}
