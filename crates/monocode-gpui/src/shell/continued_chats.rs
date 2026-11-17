//! Chats started with "Continue in new session". The newest chat of a chain
//! heads it in the sidebar, with the chats it continues on a rail beneath it,
//! and an older chat's composer points to the chat that continues it.
use super::*;
use monocode_core::agent::ContinuedChat;

impl Shell {
    /// The banner above `source`'s composer: the newest chat continuing it.
    pub(super) fn sync_continued_in(&mut self, source: i64, cx: &mut Context<Self>) {
        let Some(view) = self.sessions.get(&source).cloned() else {
            return;
        };
        let next = self
            .continued_from
            .iter()
            .filter(|(child, from)| **from == source && self.session_summaries.contains_key(child))
            .map(|(child, _)| *child)
            .max()
            .map(|child| ContinuedChat {
                session: child,
                title: self.session_metadata(child, cx).display_title(),
            });
        view.update(cx, |view, cx| view.set_continued_in(next, cx));
    }

    /// Each chain's head and the chats it continues, newest first. A source
    /// joins the rail only while it is listed on its own: a pinned chat, one
    /// in a folder, or one on another rail stays where the user put it.
    pub(super) fn continued_groups(
        &self,
        ids: &[i64],
        started: &HashMap<i64, Vec<i64>>,
        started_children: &HashSet<i64>,
        cx: &App,
    ) -> HashMap<i64, Vec<i64>> {
        let loose: HashSet<i64> = self
            .session_entries(ids, cx)
            .into_iter()
            .filter_map(|entry| match entry {
                monocode_core::session_groups::Entry::Session(id) => Some(id),
                _ => None,
            })
            .collect();
        let has_rail = |id: i64| {
            started.contains_key(&id)
                || self
                    .orchestration_summaries
                    .get(&id)
                    .is_some_and(|summary| !summary.tasks.is_empty())
        };
        continued_chains(
            ids,
            &self.continued_from,
            |id| loose.contains(&id) && !started_children.contains(&id) && !has_rail(id),
            |id| !started_children.contains(&id) && !has_rail(id),
        )
    }

    /// The tooltip on a continued chat's mark.
    pub(super) fn continued_label(
        &self,
        id: i64,
        rail: Option<&[i64]>,
        cx: &App,
    ) -> Option<String> {
        match rail {
            Some([only]) => Some(format!(
                "Continues “{}”",
                self.session_metadata(*only, cx).display_title()
            )),
            Some(chain) => Some(format!("Continues {} earlier chats", chain.len())),
            None => {
                let source = *self.continued_from.get(&id)?;
                let title = self
                    .session_summaries
                    .contains_key(&source)
                    .then(|| self.session_metadata(source, cx).display_title());
                Some(match title {
                    Some(title) => format!("Continues “{title}”"),
                    None => "Continues an earlier chat".into(),
                })
            }
        }
    }
}

/// groupContinuedChats: walks each chat's sources while `joins` allows them.
/// Chats nothing listed continues are heads first, so a chain hangs under its
/// newest chat; a source left out of a chain may still head its own.
pub(super) fn continued_chains(
    ids: &[i64],
    continued_from: &HashMap<i64, i64>,
    joins: impl Fn(i64) -> bool,
    heads: impl Fn(i64) -> bool,
) -> HashMap<i64, Vec<i64>> {
    let listed: HashSet<i64> = ids.iter().copied().collect();
    let sources: HashSet<i64> = ids
        .iter()
        .filter_map(|id| continued_from.get(id).copied())
        .collect();
    let order = ids
        .iter()
        .filter(|id| !sources.contains(id))
        .chain(ids.iter().filter(|id| sources.contains(id)));
    let mut taken = HashSet::new();
    let mut groups = HashMap::new();
    for &head in order {
        if taken.contains(&head) || !heads(head) {
            continue;
        }
        let mut chain = Vec::new();
        let mut at = head;
        while let Some(&source) = continued_from.get(&at) {
            if source == head
                || !listed.contains(&source)
                || taken.contains(&source)
                || chain.contains(&source)
                || !joins(source)
            {
                break;
            }
            chain.push(source);
            at = source;
        }
        if !chain.is_empty() {
            taken.insert(head);
            taken.extend(chain.iter().copied());
            groups.insert(head, chain);
        }
    }
    groups
}

#[cfg(test)]
mod tests {
    use super::continued_chains;
    use std::collections::HashMap;

    #[test]
    fn a_chain_hangs_under_its_newest_chat() {
        // 3 continues 2, which continues 1; 9 stands alone.
        let links = HashMap::from([(3, 2), (2, 1)]);
        let groups = continued_chains(&[1, 9, 2, 3], &links, |_| true, |_| true);
        assert_eq!(groups, HashMap::from([(3, vec![2, 1])]));
    }

    #[test]
    fn a_source_that_stays_put_heads_its_own_chain() {
        // 2 is pinned: it stays, and still carries 1 beneath it.
        let links = HashMap::from([(3, 2), (2, 1)]);
        let groups = continued_chains(&[3, 2, 1], &links, |id| id != 2, |_| true);
        assert_eq!(groups, HashMap::from([(2, vec![1])]));
    }

    #[test]
    fn unlisted_sources_and_loops_end_a_chain() {
        let links = HashMap::from([(3, 2), (2, 7), (5, 4), (4, 5)]);
        let groups = continued_chains(&[3, 2, 5, 4], &links, |_| true, |_| true);
        assert_eq!(groups[&3], vec![2]);
        assert_eq!(groups.values().map(Vec::len).sum::<usize>(), 2);
    }

    #[test]
    fn a_chat_continued_twice_joins_the_first_listed() {
        let links = HashMap::from([(3, 1), (2, 1)]);
        let groups = continued_chains(&[3, 2, 1], &links, |_| true, |_| true);
        assert_eq!(groups, HashMap::from([(3, vec![1])]));
    }
}
