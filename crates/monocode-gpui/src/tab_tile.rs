//! A pinned tab's card: a small raised solid rectangle, a touch wider than
//! tall, holding one mark. Pinned cards stack into a deck, the front one on
//! top and the rest tucked behind it, each peeking out a little further right.
use crate::theme::*;
use gpui::{AnyElement, Corners, Div, Hsla, canvas, div, prelude::*, px};

pub(crate) struct TileSize {
    pub w: f32,
    pub h: f32,
    pub radius: f32,
}

/// Title-bar tabs.
pub(crate) const TAB_TILE: TileSize = TileSize {
    w: 24.,
    h: 20.,
    radius: 5.,
};

/// How far each tile behind sticks out past the one in front.
const PEEK: f32 = 4.;
/// How much smaller each tile behind is, on each axis.
const SHRINK: f32 = 2.;
/// Cards drawn in the deck; further pins wait out of sight behind it.
pub(crate) const STACK_MAX: usize = 3;

/// The left inset that matches a pinned card's gap above and below it.
pub(crate) fn tab_tile_inset() -> f32 {
    (TAB_PLATE_HEIGHT - TAB_TILE.h) / 2.
}

/// The whole tile surface, painted in one pass over one rect so every layer
/// lines up: a hairline lift below it, the solid neutral fill, a faint sheen
/// and the border. Every tile is opaque, so the
/// ones further back in a stack never show through it. `tilt` (degrees,
/// clockwise) turns the card about its centre mid-shuffle; quads can't
/// rotate, so a tilted card is painted as paths instead.
fn surface(radius: f32, depth: usize, lifted: f32, tilt: f32) -> impl IntoElement {
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let light = is_light();
            let sheen = white(if light { 0.35 } else { 0.05 });
            let rim = content(if depth == 0 { 0.1 } else { 0.06 });
            let (top, bottom) = neutral_shades(depth);
            if tilt.abs() > 0.05 {
                paint_tilted(
                    bounds,
                    radius,
                    tilt,
                    (top, bottom),
                    sheen,
                    rim,
                    lifted,
                    window,
                );
                return;
            }
            let corners = Corners::all(px(radius));
            // A card picked up off the stack casts a deeper, softer shadow.
            if lifted > 0. {
                window.paint_drop_shadows(
                    bounds,
                    corners,
                    &[gpui::BoxShadow::new(
                        px(0.),
                        px(1. + 4. * lifted),
                        black((if light { 0.18 } else { 0.45 }) * lifted),
                    )
                    .blur_radius(px(2. + 6. * lifted))],
                );
            }
            if depth == 0 {
                let mut lift = bounds;
                lift.origin.y += px(1.);
                window.paint_quad(
                    gpui::fill(lift, black(if light { 0.1 } else { 0.3 })).corner_radii(corners),
                );
            }
            window.paint_quad(
                gpui::fill(
                    bounds,
                    gpui::linear_gradient(
                        180.,
                        gpui::linear_color_stop(top, 0.),
                        gpui::linear_color_stop(bottom, 1.),
                    ),
                )
                .corner_radii(corners),
            );
            // Brighter at the top, like light on a raised face.
            window.paint_quad(
                gpui::fill(
                    bounds,
                    gpui::linear_gradient(
                        180.,
                        gpui::linear_color_stop(sheen, 0.),
                        gpui::linear_color_stop(white(0.), 1.),
                    ),
                )
                .corner_radii(corners),
            );
            window.paint_quad(
                gpui::fill(bounds, gpui::transparent_black())
                    .corner_radii(corners)
                    .border_widths(px(1.))
                    .border_color(rim),
            );
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// The outline of a rounded rect turned `tilt` degrees about its centre,
/// grown by `grow` on every side (negative to inset it).
fn tilted_outline(
    bounds: gpui::Bounds<gpui::Pixels>,
    radius: f32,
    tilt: f32,
    grow: f32,
) -> Vec<gpui::Point<gpui::Pixels>> {
    const STEPS: usize = 5;
    let (cx, cy) = (f32::from(bounds.center().x), f32::from(bounds.center().y));
    let (hw, hh) = (
        f32::from(bounds.size.width) / 2. + grow,
        f32::from(bounds.size.height) / 2. + grow,
    );
    let r = (radius + grow).clamp(0., hw.min(hh));
    let (sin, cos) = tilt.to_radians().sin_cos();
    let mut points = Vec::with_capacity(4 * (STEPS + 1));
    // Each corner's arc centre, and the angle its quarter turn starts at.
    for (sx, sy, start) in [
        (1., -1., -90f32),
        (1., 1., 0.),
        (-1., 1., 90.),
        (-1., -1., 180.),
    ] {
        let (ax, ay) = (sx * (hw - r), sy * (hh - r));
        for step in 0..=STEPS {
            let a = (start + 90. * step as f32 / STEPS as f32).to_radians();
            let (x, y) = (ax + r * a.cos(), ay + r * a.sin());
            points.push(gpui::point(
                px(cx + x * cos - y * sin),
                px(cy + x * sin + y * cos),
            ));
        }
    }
    points
}

/// [`surface`] for a tilted card: the same layers as paths.
#[allow(clippy::too_many_arguments)]
fn paint_tilted(
    bounds: gpui::Bounds<gpui::Pixels>,
    radius: f32,
    tilt: f32,
    (top, bottom): (Hsla, Hsla),
    sheen: Hsla,
    rim: Hsla,
    lifted: f32,
    window: &mut gpui::Window,
) {
    let light = is_light();
    let fill = |points: &[gpui::Point<gpui::Pixels>]| {
        let mut path = gpui::PathBuilder::fill();
        path.add_polygon(points, true);
        path.build().ok()
    };
    // The light falls from straight above, so the face's gradient turns
    // with the card.
    let angle = 180. + tilt;
    let outline = tilted_outline(bounds, radius, tilt, 0.);
    // A soft shadow: a few widening, fainter rings below the card.
    let shadow = black((if light { 0.07 } else { 0.16 }) * lifted.max(0.4));
    for ring in 0..3 {
        let mut below = bounds;
        below.origin.y += px(1. + 3. * lifted);
        if let Some(path) = fill(&tilted_outline(below, radius, tilt, ring as f32)) {
            window.paint_path(path, shadow);
        }
    }
    if let Some(path) = fill(&outline) {
        window.paint_path(
            path,
            gpui::linear_gradient(
                angle,
                gpui::linear_color_stop(top, 0.),
                gpui::linear_color_stop(bottom, 1.),
            ),
        );
    }
    if let Some(path) = fill(&outline) {
        window.paint_path(
            path,
            gpui::linear_gradient(
                angle,
                gpui::linear_color_stop(sheen, 0.),
                gpui::linear_color_stop(white(0.), 1.),
            ),
        );
    }
    let mut stroke = gpui::PathBuilder::stroke(px(1.));
    stroke.add_polygon(&tilted_outline(bounds, radius, tilt, -0.5), true);
    if let Ok(path) = stroke.build() {
        window.paint_path(path, rim);
    }
}

/// The neutral tile's top and bottom: a solid grey gradient in the
/// theme's ink hue, raised above the surface like the coloured tiles. Each
/// step back is a shade deeper. Solid, so a stack's front tile hides the
/// ones behind it without a backdrop blur, which would break the frame's
/// render pass per tile.
fn neutral_shades(depth: usize) -> (Hsla, Hsla) {
    let shade = |l: f32| {
        let mut c = content(1.);
        c.s = c.s.min(0.08);
        c.l = l - depth as f32 * 0.03;
        c.a = 1.;
        c
    };
    if is_light() {
        (shade(1.), shade(0.93))
    } else {
        (shade(0.27), shade(0.2))
    }
}

/// One tile at `depth` in a stack (0 is the front), each step back smaller;
/// the front tile alone carries the lift and the brighter border. `lifted`
/// runs from 0 resting to 1 held up high, turned `tilt` degrees clockwise.
fn tile_lifted(size: &TileSize, depth: f32, mark: AnyElement, lifted: f32, tilt: f32) -> Div {
    let shrink = depth * SHRINK;
    div()
        .w(px(size.w - shrink))
        .h(px(size.h - shrink))
        .relative()
        .flex()
        .items_center()
        .justify_center()
        .child(surface(
            size.radius,
            depth.max(0.).round() as usize,
            lifted,
            tilt,
        ))
        .child(mark)
}

/// How far each of the two swapping cards in a shuffle is pulled out to
/// its side, how far the outgoing one rises, and how far each tilts
/// (degrees).
const SHUFFLE_SPREAD: f32 = 9.;
const SHUFFLE_LIFT: f32 = 2.;
const SHUFFLE_TILT: f32 = 12.;

/// One card's swing in a deck shuffle, off its place in the stack.
struct Shuffled {
    dx: f32,
    dy: f32,
    lifted: f32,
    tilt: f32,
    /// Drawing order: lower paints later, on top.
    z: f32,
}

/// Where a card moving from stack depth `from` to `to` swings, `t` (linear,
/// 0 to 1) through the shuffle, resting at `depth` meanwhile.
fn shuffled(from: f32, to: f32, depth: f32, t: f32) -> Shuffled {
    // Apart and back: widest halfway, where the two cards change places.
    let arc = (t * std::f32::consts::PI).sin();
    if from == 0. && to > 0. {
        // The card being put back: out to the left, tilting back, on top
        // until the two are apart, then under.
        Shuffled {
            dx: -arc * SHUFFLE_SPREAD,
            dy: -arc * SHUFFLE_LIFT,
            lifted: arc,
            tilt: -arc * SHUFFLE_TILT,
            z: if t < 0.5 { -1. } else { to },
        }
    } else if to == 0. && from > 0. {
        // The card being dealt: out to the right, tilting the other way,
        // then over the stack and into the front.
        Shuffled {
            dx: arc * SHUFFLE_SPREAD,
            dy: 0.,
            lifted: arc * 0.6,
            tilt: arc * SHUFFLE_TILT,
            z: if t < 0.5 { from } else { -1. },
        }
    } else {
        Shuffled {
            dx: 0.,
            dy: 0.,
            lifted: 0.,
            tilt: 0.,
            z: depth,
        }
    }
}

/// The ink for a mark on a tile: white on dark, near-black on light.
pub(crate) fn tile_ink() -> Hsla {
    if is_light() {
        black(0.85)
    } else {
        gpui::white()
    }
}

/// Between pinned cards once they fan out.
pub(crate) const FAN_GAP: f32 = 6.;

/// Where one pinned card sits, `fan` (eased, 0 stacked to 1 spread out)
/// of the way from the deck to its own slot in a row.
pub(crate) struct FanCard {
    pub x: f32,
    pub y: f32,
    pub depth: f32,
    pub opacity: f32,
    pub lifted: f32,
    pub tilt: f32,
    /// Drawing order: lower paints later, on top.
    pub z: f32,
}

/// The deck the pinned tabs rest in, and the row they fan out into. `front`
/// is the card on top of the deck; the rest tuck behind it in pin order,
/// Fanning out, every card slides straight
/// along into its own slot in pin order, growing back to full size.
/// `shuffle` is the card that was on top and how far (linear, 0 to 1) the
/// deck is through dealing `front` in its place.
pub(crate) fn fan_card(
    size: &TileSize,
    ix: usize,
    front: usize,
    fan: f32,
    shuffle: Option<(usize, f32)>,
) -> FanCard {
    let fan = fan.clamp(0., 1.);
    let place = |front: usize| {
        if ix == front {
            0.
        } else if ix < front {
            ix as f32 + 1.
        } else {
            ix as f32
        }
    };
    let to = place(front);
    let (from, t) = shuffle.map_or((to, 1.), |(was, t)| (place(was), t.clamp(0., 1.)));
    let travel = t * t * (3. - 2. * t);
    let stacked = from + (to - from) * travel;
    let last = (STACK_MAX - 1) as f32;
    let resting = stacked.min(last);
    let swing = shuffled(from, to, resting, t);
    // The swing belongs to the deck; spread out, the cards lie level.
    let still = 1. - fan;
    let depth = resting * still;
    let shrink = depth * SHRINK;
    let deck_x = resting * PEEK + resting * SHRINK + swing.dx;
    let row_x = ix as f32 * (size.w + FAN_GAP);
    // Past the third card the deck hides them; they surface as it spreads.
    let hidden = (stacked - last).clamp(0., 1.);
    let opacity = 1. - hidden * still;
    FanCard {
        x: deck_x + (row_x - deck_x) * fan,
        y: shrink / 2. + swing.dy * still,
        depth,
        opacity,
        lifted: swing.lifted * still,
        tilt: swing.tilt * still,
        z: swing.z * still + ix as f32 * fan * 0.01,
    }
}

/// How wide the pinned deck is, `fan` of the way to the spread-out row.
pub(crate) fn fan_width(size: &TileSize, count: usize, fan: f32) -> f32 {
    if count == 0 {
        return 0.;
    }
    let shown = count.min(STACK_MAX) as f32;
    let deck = size.w + (shown - 1.) * PEEK;
    let row = count as f32 * size.w + (count - 1) as f32 * FAN_GAP;
    deck + (row - deck) * fan.clamp(0., 1.)
}

/// One pinned card's tile, placed by [`fan_card`].
pub(crate) fn fan_tile(size: &TileSize, card: &FanCard, mark: AnyElement) -> Div {
    tile_lifted(size, card.depth, mark, card.lifted, card.tilt)
}

#[cfg(test)]
mod fan_tests {
    use super::*;

    #[test]
    fn a_resting_deck_stacks_and_spreads_into_a_row() {
        // At rest the front card is on top at the left; the others peek out.
        let front = fan_card(&TAB_TILE, 2, 2, 0., None);
        assert_eq!((front.x, front.depth, front.z), (0., 0., 0.));
        let behind = fan_card(&TAB_TILE, 0, 2, 0., None);
        assert_eq!(behind.depth, 1.);
        // Past the third card they wait hidden behind the deck.
        assert_eq!(fan_card(&TAB_TILE, 4, 0, 0., None).opacity, 0.);
        // Spread, each card sits in its own slot, full size and level.
        for ix in 0..5 {
            let card = fan_card(&TAB_TILE, ix, 2, 1., None);
            assert_eq!(card.x, ix as f32 * (TAB_TILE.w + FAN_GAP));
            assert_eq!((card.depth, card.opacity), (0., 1.));
        }
        // Dealing a new front card swings the two apart, tilting, and
        // settles with the new one on top.
        let dealt = fan_card(&TAB_TILE, 1, 1, 0., Some((0, 0.5)));
        let put_back = fan_card(&TAB_TILE, 0, 1, 0., Some((0, 0.5)));
        assert!(dealt.tilt > 0. && put_back.tilt < 0.);
        assert!(put_back.x < dealt.x);
        let settled = fan_card(&TAB_TILE, 1, 1, 0., Some((0, 1.)));
        assert!(settled.x.abs() < 1e-4);
        assert!(settled.tilt.abs() < 1e-4);
        assert_eq!(fan_width(&TAB_TILE, 1, 1.), TAB_TILE.w);
        assert_eq!(fan_width(&TAB_TILE, 5, 0.), TAB_TILE.w + 2. * PEEK);
        assert_eq!(fan_width(&TAB_TILE, 3, 1.), 3. * TAB_TILE.w + 2. * FAN_GAP);
    }
}
