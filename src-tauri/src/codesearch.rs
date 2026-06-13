use anyhow::{Context, Result};
use arrow_array::{Array, Float32Array, Int32Array, RecordBatch, StringArray};
use futures::TryStreamExt;
use lancedb::query::{ExecutableQuery, QueryBase};
use serde::{Deserialize, Serialize};

/// One search hit returned to the webview.
#[derive(Serialize)]
pub struct Hit {
    pub relative: String,
    pub language: String,
    pub line_start: i32,
    pub line_end: i32,
    pub distance: f32,
    pub text: String,
}

/// Embed a query through the configured Ollama (same model the index was built
/// with, so the vectors are comparable).
async fn embed_query(ollama: &str, model: &str, query: &str) -> Result<Vec<f32>> {
    #[derive(Serialize)]
    struct Req<'a> {
        model: &'a str,
        input: [&'a str; 1],
    }
    #[derive(Deserialize)]
    struct Resp {
        embeddings: Vec<Vec<f32>>,
    }
    let url = format!("{}/api/embed", ollama.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&Req { model, input: [query] })
        .send()
        .await
        .with_context(|| format!("POST {url} (is Ollama running?)"))?
        .error_for_status()
        .context("Ollama embed returned an error")?
        .json::<Resp>()
        .await
        .context("parsing Ollama embed response")?;
    resp.embeddings.into_iter().next().context("no embedding returned")
}

/// k-NN search over a local LanceDB index produced by rebase-indexer.
pub async fn search(
    index_path: &str,
    query: &str,
    ollama: &str,
    model: &str,
    k: usize,
) -> Result<Vec<Hit>> {
    let qv = embed_query(ollama, model, query).await?;
    let db = lancedb::connect(index_path).execute().await?;
    let tbl = db.open_table("chunks").execute().await?;
    let batches: Vec<RecordBatch> = tbl
        .query()
        .nearest_to(qv)?
        .limit(k)
        .execute()
        .await?
        .try_collect()
        .await?;

    let mut hits = Vec::new();
    for b in &batches {
        let rel = col_str(b, "relative")?;
        let lang = col_str(b, "language")?;
        let ls = col_i32(b, "line_start")?;
        let le = col_i32(b, "line_end")?;
        let txt = col_str(b, "text")?;
        let dist = col_f32(b, "_distance")?;
        for i in 0..b.num_rows() {
            hits.push(Hit {
                relative: rel.value(i).to_string(),
                language: lang.value(i).to_string(),
                line_start: ls.value(i),
                line_end: le.value(i),
                distance: dist.value(i),
                text: txt.value(i).to_string(),
            });
        }
    }
    Ok(hits)
}

fn col_str<'a>(b: &'a RecordBatch, name: &str) -> Result<&'a StringArray> {
    b.column_by_name(name)
        .and_then(|c| c.as_any().downcast_ref::<StringArray>())
        .with_context(|| format!("column {name} (utf8) missing"))
}
fn col_i32<'a>(b: &'a RecordBatch, name: &str) -> Result<&'a Int32Array> {
    b.column_by_name(name)
        .and_then(|c| c.as_any().downcast_ref::<Int32Array>())
        .with_context(|| format!("column {name} (i32) missing"))
}
fn col_f32<'a>(b: &'a RecordBatch, name: &str) -> Result<&'a Float32Array> {
    b.column_by_name(name)
        .and_then(|c| c.as_any().downcast_ref::<Float32Array>())
        .with_context(|| format!("column {name} (f32) missing"))
}
