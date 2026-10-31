//! InboxPrOverview.ts's descriptionExcerpt: the plain-text lead of a
//! markdown body, so a narrow panel can show a few lines instead of loading
//! the description's images, embeds and code blocks.
use regex::Regex;
use std::sync::LazyLock;

const EXCERPT_LINES: usize = 4;
const EXCERPT_CHARS: usize = 360;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DescriptionExcerpt {
    pub text: String,
    pub images: usize,
    /// True when the excerpt drops anything the full render would show.
    pub truncated: bool,
}

macro_rules! re {
    ($name:ident, $pattern:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pattern).unwrap());
    };
}
re!(IMAGE, r"!\[[^\]]*\]\([^)]*\)");
re!(IMG_TAG, r"(?i)<img\b");
re!(VIDEO_TAG, r"(?i)<video\b");
re!(BLOCK, r"(?m)^\s*(```|~~~|\|.*\|)");
re!(DETAILS_TAG, r"(?i)<details\b");
re!(COMMENT, r"(?s)<!--.*?-->");
re!(BACKTICK_FENCE, r"(?s)```.*?(```|\z)");
re!(TILDE_FENCE, r"(?s)~~~.*?(~~~|\z)");
re!(DETAILS, r"(?is)<details\b.*?(</details>|\z)");
re!(TAG, r"<[^>]+>");
re!(LINK, r"\[([^\]]*)\]\([^)]*\)");
re!(
    MARKER,
    r"^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)"
);
re!(EMPHASIS, r"(\*\*|__|~~|`)");
re!(RULE, r"^\s*([-*_]\s*){3,}$");
re!(TABLE_ROW, r"^\s*\|.*\|\s*$");

pub fn description_excerpt(body: &str) -> DescriptionExcerpt {
    let images = IMAGE.find_iter(body).count()
        + IMG_TAG.find_iter(body).count()
        + VIDEO_TAG.find_iter(body).count();
    let has_blocks = BLOCK.is_match(body) || DETAILS_TAG.is_match(body);
    let stripped = COMMENT.replace_all(body, "");
    let stripped = BACKTICK_FENCE.replace_all(&stripped, "");
    let stripped = TILDE_FENCE.replace_all(&stripped, "");
    let stripped = DETAILS.replace_all(&stripped, "");
    let stripped = IMAGE.replace_all(&stripped, "");
    let stripped = TAG.replace_all(&stripped, "");
    let stripped = LINK.replace_all(&stripped, "$1");
    let lines: Vec<String> = stripped
        .split('\n')
        .map(|line| {
            let line = MARKER.replace(line, "");
            let line = EMPHASIS.replace_all(&line, "");
            let line = RULE.replace(&line, "");
            let line = TABLE_ROW.replace(&line, "");
            line.trim().to_owned()
        })
        .filter(|line| !line.is_empty())
        .collect();
    let mut text = lines
        .iter()
        .take(EXCERPT_LINES)
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    let clipped = text.chars().count() > EXCERPT_CHARS;
    if clipped {
        let cut: String = text.chars().take(EXCERPT_CHARS).collect();
        text = format!("{}…", cut.trim_end());
    }
    DescriptionExcerpt {
        text,
        images,
        truncated: clipped || lines.len() > EXCERPT_LINES || images > 0 || has_blocks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_plain_body_is_not_truncated() {
        let excerpt = description_excerpt("Fixes the **crash** in `main`.\n\n- one\n- two");
        assert_eq!(excerpt.text, "Fixes the crash in main.\none\ntwo");
        assert!(!excerpt.truncated);
        assert_eq!(excerpt.images, 0);
    }

    #[test]
    fn markup_media_and_blocks_are_left_out_of_the_lead() {
        let body = "## What\n\n<!-- template -->\nSee [the docs](https://x.y) first.\n\n\
                    ![shot](a.png)\n<img src=\"b.png\">\n\n```rust\nfn main() {}\n```\n\n\
                    <details><summary>Log</summary>\nnoise\n</details>\n\n| a | b |\n|---|---|\n\n---\n> Quoted";
        let excerpt = description_excerpt(body);
        assert_eq!(excerpt.text, "What\nSee the docs first.\nQuoted");
        assert_eq!(excerpt.images, 2);
        assert!(excerpt.truncated);
    }

    #[test]
    fn long_leads_are_cut_by_lines_and_characters() {
        let many = description_excerpt("1\n2\n3\n4\n5");
        assert_eq!(many.text, "1\n2\n3\n4");
        assert!(many.truncated);
        let long = description_excerpt(&"word ".repeat(100));
        assert!(long.text.ends_with('…'));
        assert!(long.text.chars().count() <= EXCERPT_CHARS + 1);
        assert!(long.truncated);
    }
}
