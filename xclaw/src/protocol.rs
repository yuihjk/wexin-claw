use serde_json::Value;

pub fn get_string_at(value: &Value, path: &[&str]) -> Option<String> {
    let mut cursor = value;
    for key in path {
        cursor = cursor.get(*key)?;
    }
    cursor.as_str().map(ToString::to_string)
}

pub fn get_array_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Vec<Value>> {
    let mut cursor = value;
    for key in path {
        cursor = cursor.get(*key)?;
    }
    cursor.as_array()
}

pub fn extract_thread_id(params: &Value) -> Option<String> {
    [
        &["threadId"][..],
        &["thread_id"][..],
        &["thread", "id"][..],
        &["turn", "threadId"][..],
        &["turn", "thread_id"][..],
        &["item", "threadId"][..],
        &["item", "thread_id"][..],
    ]
    .iter()
    .find_map(|path| get_string_at(params, path))
}

pub fn extract_turn_id(params: &Value) -> Option<String> {
    [&["turnId"][..], &["turn_id"][..], &["turn", "id"][..]]
        .iter()
        .find_map(|path| get_string_at(params, path))
}

pub fn extract_delta_text(params: &Value) -> Option<String> {
    [
        &["delta"][..],
        &["text"][..],
        &["item", "text"][..],
        &["message", "text"][..],
    ]
    .iter()
    .find_map(|path| get_string_at(params, path))
}

pub fn extract_completed_agent_text(params: &Value) -> Option<String> {
    let item_type =
        get_string_at(params, &["item", "type"]).or_else(|| get_string_at(params, &["type"]));
    if matches!(item_type.as_deref(), Some(value) if value != "agent_message" && value != "agentMessage")
    {
        return None;
    }
    get_string_at(params, &["item", "text"]).or_else(|| get_string_at(params, &["text"]))
}

pub fn extract_error_message(params: &Value) -> Option<String> {
    get_string_at(params, &["message"]).or_else(|| get_string_at(params, &["error", "message"]))
}

pub fn short_id(value: &str) -> String {
    if value.chars().count() <= 10 {
        value.to_string()
    } else {
        let start: String = value.chars().take(4).collect();
        let end: String = value
            .chars()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("{start}...{end}")
    }
}
