//! Upstream HTTP client trait + the production reqwest implementation.
//!
//! Why a trait: handler tests need to assert "given this request, the
//! handler called the upstream with these headers and body, and produced
//! this output from this fake SSE stream." Without a trait to mock,
//! we'd have to spin up a real HTTP server in tests, which is slower
//! and flakier. The trait surface is intentionally tiny — just enough
//! for handler use.

use async_trait::async_trait;
use bytes::Bytes;
use futures::Stream;
use std::collections::HashMap;
use std::pin::Pin;

/// Streamed response body. Same shape as the handler-facing
/// `BodyStream` so it threads cleanly through both layers without
/// reboxing.
pub type UpstreamBody =
    Pin<Box<dyn Stream<Item = std::result::Result<Bytes, std::io::Error>> + Send + 'static>>;

pub struct UpstreamRequest {
    pub method:  String,
    pub url:     String,
    pub headers: HashMap<String, String>,
    pub body:    Bytes,
}

pub struct UpstreamResponse {
    pub status:  u16,
    pub headers: HashMap<String, String>,
    pub body:    UpstreamBody,
}

#[async_trait]
pub trait UpstreamClient: Send + Sync {
    async fn send(
        &self,
        req: UpstreamRequest,
    ) -> std::result::Result<UpstreamResponse, std::io::Error>;
}

/// Production implementation backed by `reqwest`. The platform shell
/// builds one of these at startup; tests substitute their own.
pub struct ReqwestClient {
    client: reqwest::Client,
}

impl ReqwestClient {
    pub fn new() -> std::io::Result<Self> {
        // `rustls-tls` is enabled in Cargo.toml; reqwest will use it
        // automatically. `pool_idle_timeout(Some(60s))` mirrors the TS
        // agent's keep-alive sane-default.
        let client = reqwest::Client::builder()
            .pool_idle_timeout(std::time::Duration::from_secs(60))
            .user_agent("sci-agent/0.5.0")
            .build()
            .map_err(std::io::Error::other)?;
        Ok(Self { client })
    }
}

#[async_trait]
impl UpstreamClient for ReqwestClient {
    async fn send(
        &self,
        req: UpstreamRequest,
    ) -> std::result::Result<UpstreamResponse, std::io::Error> {
        let method = reqwest::Method::from_bytes(req.method.as_bytes())
            .map_err(std::io::Error::other)?;
        let mut builder = self.client.request(method, &req.url).body(req.body);
        for (k, v) in req.headers {
            builder = builder.header(k, v);
        }
        let resp = builder.send().await.map_err(std::io::Error::other)?;
        let status = resp.status().as_u16();
        let mut headers = HashMap::with_capacity(resp.headers().len());
        for (k, v) in resp.headers().iter() {
            if let Ok(s) = v.to_str() {
                headers.insert(k.as_str().to_lowercase(), s.to_string());
            }
        }
        // `bytes_stream()` returns `impl Stream<Item = Result<Bytes,
        // reqwest::Error>>`. Map the error into io::Error so the type
        // matches the trait.
        let body = resp.bytes_stream();
        let mapped = futures::StreamExt::map(body, |r| r.map_err(std::io::Error::other));
        Ok(UpstreamResponse {
            status,
            headers,
            body: Box::pin(mapped),
        })
    }
}
