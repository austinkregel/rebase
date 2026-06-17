mod cmd;

use anyhow::Result;
use clap::{Parser, Subcommand};

use cmd::{auth, cp, keys};

#[derive(Parser)]
#[command(
    name = "rebase",
    about = "Rebase CLI — manage auth, control planes, and agents from your terminal",
    version
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Authentication and credentials
    Auth {
        #[command(subcommand)]
        command: auth::AuthCmd,
    },
    /// Control plane configuration
    Cp {
        #[command(subcommand)]
        command: cp::CpCmd,
    },
    /// SSH key management
    Keys {
        #[command(subcommand)]
        command: keys::KeysCmd,
    },
}

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    // Install the rustls process-wide crypto provider so any TLS handshakes
    // in this process (token endpoint, control plane API) work.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let cli = Cli::parse();
    match cli.command {
        Commands::Auth { command } => auth::run(command).await,
        Commands::Cp { command } => cp::run(command),
        Commands::Keys { command } => keys::run(command).await,
    }
}
