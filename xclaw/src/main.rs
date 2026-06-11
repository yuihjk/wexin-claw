mod channel;
mod codex;
mod commands;
mod config;
mod logger;
mod protocol;
mod router;
mod text;
mod thread_store;
mod types;

use std::sync::Arc;

use anyhow::Result;
use channel::ChannelSupervisor;
use codex::CodexAppServerClient;
use config::load_config;
use logger::Logger;
use router::MessageRouter;
use thread_store::ThreadStore;
use tokio::{
    sync::RwLock,
    time::{Duration, timeout},
};

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        eprintln!("[xclaw] fatal: {err:?}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let (paths, config) = load_config()?;
    let logger = Logger::new(paths.logs.clone());
    logger
        .info(format!("xclaw starting home={}", paths.home))
        .await;

    let thread_store = Arc::new(RwLock::new(ThreadStore::new(format!(
        "{}/threads.json",
        paths.state
    ))));
    let known_store = thread_store.clone();
    let known_thread_count = Arc::new(move || {
        known_store
            .try_read()
            .map(|store| store.size())
            .unwrap_or_default()
    });

    let codex = CodexAppServerClient::new(
        config.clone(),
        paths.clone(),
        logger.clone(),
        known_thread_count,
    );
    let channel = ChannelSupervisor::new(config.clone(), paths.clone(), logger.clone());
    let router = MessageRouter::new(
        config,
        channel.clone(),
        codex.clone(),
        thread_store,
        logger.clone(),
    );

    let messages = channel.take_message_receiver().await?;
    let approvals = codex.take_approval_receiver().await?;

    logger.info("starting codex app-server client").await;
    codex.start().await?;
    logger.info("starting channel worker").await;
    channel.start().await?;
    logger.info("xclaw ready").await;

    let router_for_messages = router.clone();
    tokio::spawn(async move {
        router_for_messages.run_messages(messages).await;
    });
    let router_for_approvals = router.clone();
    tokio::spawn(async move {
        router_for_approvals.run_approvals(approvals).await;
    });

    shutdown_signal().await?;
    logger.info("received shutdown signal, stopping...").await;
    let _ = timeout(Duration::from_secs(5), channel.stop()).await;
    let _ = timeout(Duration::from_secs(5), codex.stop()).await;
    Ok(())
}

async fn shutdown_signal() -> Result<()> {
    #[cfg(unix)]
    {
        let mut sigterm =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result?,
            _ = sigterm.recv() => {},
        }
        Ok(())
    }

    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await?;
        Ok(())
    }
}
