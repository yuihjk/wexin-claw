use std::{collections::HashMap, fs, path::Path};

use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ThreadRecord {
    #[serde(rename = "threadId")]
    thread_id: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

#[derive(Debug)]
pub struct ThreadStore {
    file_path: String,
    data: HashMap<String, ThreadRecord>,
}

impl ThreadStore {
    pub fn new(file_path: String) -> Self {
        let data = fs::read_to_string(&file_path)
            .ok()
            .and_then(|text| serde_json::from_str::<HashMap<String, ThreadRecord>>(&text).ok())
            .unwrap_or_default();
        Self { file_path, data }
    }

    pub fn size(&self) -> usize {
        self.data.len()
    }

    pub fn get(&self, sender_id: &str) -> Option<String> {
        self.data
            .get(sender_id)
            .map(|record| record.thread_id.clone())
    }

    pub fn find_sender_by_thread(&self, thread_id: &str) -> Option<String> {
        self.data
            .iter()
            .find(|(_, record)| record.thread_id == thread_id)
            .map(|(sender_id, _)| sender_id.clone())
    }

    pub fn set(&mut self, sender_id: &str, thread_id: String) -> Result<()> {
        self.data.insert(
            sender_id.to_string(),
            ThreadRecord {
                thread_id,
                updated_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            },
        );
        self.save()
    }

    pub fn delete(&mut self, sender_id: &str) -> Result<()> {
        self.data.remove(sender_id);
        self.save()
    }

    fn save(&self) -> Result<()> {
        let path = Path::new(&self.file_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        let tmp = format!("{}.tmp", self.file_path);
        fs::write(&tmp, serde_json::to_string_pretty(&self.data)?)
            .with_context(|| format!("failed to write {tmp}"))?;
        fs::rename(&tmp, &self.file_path)
            .with_context(|| format!("failed to rename {tmp} to {}", self.file_path))?;
        Ok(())
    }
}
