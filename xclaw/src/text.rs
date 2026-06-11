pub fn split_reply(text: &str, max_chars: usize) -> Vec<String> {
    let normalized = text.trim();
    if normalized.is_empty() {
        return vec![];
    }
    if normalized.chars().count() <= max_chars {
        return vec![normalized.to_string()];
    }

    let mut chunks = Vec::new();
    let mut rest = normalized.to_string();
    while rest.chars().count() > max_chars {
        let slice: String = rest.chars().take(max_chars).collect();
        let break_at = ["\n\n", "\n", "。", ". "]
            .iter()
            .filter_map(|needle| slice.rfind(needle).map(|index| index + needle.len()))
            .max()
            .unwrap_or(0);
        let cut = if break_at > max_chars / 2 {
            break_at
        } else {
            slice.len()
        };
        chunks.push(rest[..cut].trim().to_string());
        rest = rest[cut..].trim().to_string();
    }
    if !rest.is_empty() {
        chunks.push(rest);
    }
    chunks
}

pub fn merge_waiting_messages(messages: &[String]) -> String {
    let cleaned: Vec<&str> = messages
        .iter()
        .map(|message| message.trim())
        .filter(|message| !message.is_empty())
        .collect();
    if cleaned.len() <= 1 {
        return cleaned.first().copied().unwrap_or_default().to_string();
    }
    format!(
        "以下是用户在等待期间连续发送的消息，请作为同一个请求处理：\n\n---\n{}\n---",
        cleaned.join("\n\n\n")
    )
}

pub fn pending_char_count(messages: &[String]) -> usize {
    messages.iter().map(|message| message.chars().count()).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_waiting_messages() {
        let merged = merge_waiting_messages(&["a".to_string(), "b".to_string()]);
        assert!(merged.contains("a\n\n\nb"));
    }
}
