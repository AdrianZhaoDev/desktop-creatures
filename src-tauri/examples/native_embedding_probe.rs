//! Inspect the locked Tauri parser/code generator in an explicitly NEW OUT_DIR.
//! This is build evidence tooling; it neither starts the app nor binds an EXE.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
};
use syn::{Expr, LitStr, Token, braced, bracketed, parse::Parse, parse::ParseStream};
use tauri_utils::config::{FrontendDist, PatternKind};

const TARGET: &str = "x86_64-pc-windows-msvc";
const KIND: &str = "tauri-native-embedding-codegen-probe";
const MAX_ASSET_BYTES: u64 = 512 * 1024 * 1024;
type ProbeResult<T> = Result<T, String>;

struct Options {
    config: PathBuf,
    patch: PathBuf,
    out_dir: Option<PathBuf>,
    classify_only: bool,
}

fn options() -> ProbeResult<Options> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let mut paths = BTreeMap::new();
    let mut classify_only = false;
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--classify-only" && !classify_only {
            classify_only = true;
            index += 1;
            continue;
        }
        let key = args[index].as_str();
        if !["--config", "--override", "--out-dir"].contains(&key)
            || paths.contains_key(key)
            || index + 1 == args.len()
        {
            return Err("Expected --config ABS_FILE --override ABS_FILE and either --out-dir NEW_ABS_DIR or --classify-only".into());
        }
        let value = PathBuf::from(&args[index + 1]);
        if !value.is_absolute() {
            return Err(format!("{key} must be absolute"));
        }
        paths.insert(key.to_string(), value);
        index += 2;
    }
    let config = paths.remove("--config").ok_or("Missing --config")?;
    let patch = paths.remove("--override").ok_or("Missing --override")?;
    let out_dir = paths.remove("--out-dir");
    if classify_only == out_dir.is_some() {
        return Err(
            "Use --out-dir for generation, or --classify-only without an output directory".into(),
        );
    }
    Ok(Options {
        config,
        patch,
        out_dir,
        classify_only,
    })
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

// This is precisely the implementation used for codegen cache filenames.
fn blake3(bytes: &[u8]) -> String {
    let mut state = tauri_codegen::vendor::blake3_reference::Hasher::default();
    state.update(bytes);
    let mut result = [0u8; 32];
    state.finalize(&mut result);
    result.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn canonical(path: &Path) -> ProbeResult<PathBuf> {
    for ancestor in path.ancestors() {
        let info =
            fs::symlink_metadata(ancestor).map_err(|e| format!("{}: {e}", ancestor.display()))?;
        if info.file_type().is_symlink() {
            return Err(format!("Symlink/junction refused: {}", ancestor.display()));
        }
    }
    fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn display(path: &Path) -> ProbeResult<String> {
    let text = path.to_str().ok_or("Non-Unicode path")?;
    // Keep the raw codegen spelling separately; Node consumes ordinary local paths.
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        if rest.starts_with("UNC\\") {
            return Err("UNC paths are outside the local embedding probe boundary".into());
        }
        Ok(rest.to_string())
    } else {
        Ok(text.to_string())
    }
}

fn bytes(path: &Path) -> ProbeResult<Vec<u8>> {
    let info = fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !info.is_file() || info.file_type().is_symlink() || info.len() > MAX_ASSET_BYTES {
        return Err(format!("Not a bounded regular file: {}", path.display()));
    }
    fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

#[derive(Clone, PartialEq)]
struct Input {
    path: PathBuf,
    length: usize,
    sha256: String,
}

fn inventory(root: &Path) -> ProbeResult<BTreeMap<String, Input>> {
    fn walk(root: &Path, dir: &Path, result: &mut BTreeMap<String, Input>) -> ProbeResult<()> {
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let file = entry.map_err(|e| e.to_string())?.path();
            let info = fs::symlink_metadata(&file).map_err(|e| e.to_string())?;
            if info.file_type().is_symlink() {
                return Err(format!("Symlink asset refused: {}", file.display()));
            }
            if info.is_dir() {
                walk(root, &file, result)?;
            } else {
                let relative = file.strip_prefix(root).map_err(|e| e.to_string())?;
                let key = String::from(tauri_utils::assets::AssetKey::from(relative));
                let input = bytes(&file)?;
                if result
                    .insert(
                        key,
                        Input {
                            path: canonical(&file)?,
                            length: input.len(),
                            sha256: sha256(&input),
                        },
                    )
                    .is_some()
                {
                    return Err("Duplicate normalized asset key".into());
                }
            }
        }
        Ok(())
    }
    let mut result = BTreeMap::new();
    walk(root, root, &mut result)?;
    let folded = result
        .keys()
        .map(|key| key.to_lowercase())
        .collect::<BTreeSet<_>>();
    if folded.len() != result.len() {
        return Err("Case-aliased asset keys".into());
    }
    Ok(result)
}

struct AssetEntry {
    key: String,
    input: PathBuf,
    cache: PathBuf,
}

fn include_path(input: ParseStream<'_>) -> syn::Result<PathBuf> {
    let invocation: syn::Macro = input.parse()?;
    if !invocation.path.is_ident("include_bytes") {
        return Err(syn::Error::new_spanned(
            invocation.path,
            "Expected exact include_bytes macro",
        ));
    }
    Ok(PathBuf::from(
        syn::parse2::<LitStr>(invocation.tokens)?.value(),
    ))
}

impl Parse for AssetEntry {
    fn parse(input: ParseStream<'_>) -> syn::Result<Self> {
        let key = input.parse::<LitStr>()?.value();
        input.parse::<Token![=>]>()?;
        let body;
        braced!(body in input);
        body.parse::<Token![const]>()?;
        body.parse::<Token![_]>()?;
        body.parse::<Token![:]>()?;
        body.parse::<Token![&]>()?;
        let ty;
        bracketed!(ty in body);
        let ident: syn::Ident = ty.parse()?;
        if ident != "u8" || !ty.is_empty() {
            return Err(ty.error("Expected [u8]"));
        }
        body.parse::<Token![=]>()?;
        let original = include_path(&body)?;
        body.parse::<Token![;]>()?;
        let cache = include_path(&body)?;
        if !body.is_empty() {
            return Err(body.error("Unexpected code in embedded asset mapping"));
        }
        Ok(Self {
            key,
            input: original,
            cache,
        })
    }
}

struct AssetMap(Vec<AssetEntry>);
impl Parse for AssetMap {
    fn parse(input: ParseStream<'_>) -> syn::Result<Self> {
        let mut entries = Vec::new();
        while !input.is_empty() {
            entries.push(input.parse()?);
            if !input.is_empty() {
                input.parse::<Token![,]>()?;
            }
        }
        Ok(Self(entries))
    }
}

// Inspect the final inner(assets) expression, never a coincidental string or a
// map elsewhere in the generated Config/CSP/ACL tokens.
fn asset_map(expression: Expr) -> ProbeResult<Vec<AssetEntry>> {
    let Expr::Block(outer) = expression else {
        return Err("Unexpected context expression".into());
    };
    let Some(syn::Stmt::Expr(Expr::Call(inner), None)) = outer.block.stmts.last() else {
        return Err("Missing final inner(assets)".into());
    };
    let Expr::Path(callee) = inner.func.as_ref() else {
        return Err("Unexpected context callee".into());
    };
    if !callee.path.is_ident("inner") || inner.args.len() != 1 {
        return Err("Unexpected context call shape".into());
    }
    let Some(Expr::Block(block)) = inner.args.first() else {
        return Err("Custom/empty asset expression refused".into());
    };
    let Some(syn::Stmt::Expr(Expr::Call(constructor), None)) = block.block.stmts.last() else {
        return Err("Missing EmbeddedAssets constructor".into());
    };
    let Expr::Path(callee) = constructor.func.as_ref() else {
        return Err("Unexpected assets callee".into());
    };
    let names = callee
        .path
        .segments
        .iter()
        .map(|s| s.ident.to_string())
        .collect::<Vec<_>>();
    if names != ["EmbeddedAssets", "new"] || constructor.args.len() != 3 {
        return Err("Unexpected EmbeddedAssets constructor".into());
    }
    let Some(Expr::Macro(map)) = constructor.args.first() else {
        return Err("Missing asset phf_map".into());
    };
    if !map.mac.path.is_ident("phf_map") {
        return Err("Unexpected embedded assets map".into());
    }
    let parsed = syn::parse2::<AssetMap>(map.mac.tokens.clone()).map_err(|e| e.to_string())?;
    if parsed.0.is_empty() {
        return Err("Empty EmbeddedAssets refused".into());
    }
    Ok(parsed.0)
}

fn run() -> ProbeResult<Value> {
    let options = options()?;
    let config_path = canonical(&options.config)?;
    let patch_path = canonical(&options.patch)?;
    let patch_bytes = bytes(&patch_path)?;
    let _: Value = serde_json::from_slice(&patch_bytes).map_err(|e| e.to_string())?;
    // Single-threaded probe process: these are explicit CLI inputs, not ambient
    // overrides. get_config applies the locked parser and JSON Merge Patch.
    unsafe {
        env::set_var(
            "TAURI_CONFIG",
            String::from_utf8(patch_bytes.clone()).map_err(|e| e.to_string())?,
        );
        env::set_var("TAURI_ENV_TARGET_TRIPLE", TARGET);
    }
    let (config, config_parent) =
        tauri_codegen::get_config(&config_path).map_err(|e| e.to_string())?;
    let variant = match &config.build.frontend_dist {
        Some(FrontendDist::Directory(_)) => "Directory",
        Some(FrontendDist::Url(_)) => "Url",
        Some(FrontendDist::Files(_)) => "Files",
        None => "None",
        _ => "Unknown",
    };
    let mut report = json!({
        "schemaVersion": 1, "kind": KIND, "verified": false,
        "nativeExecutableBound": false, "target": TARGET, "dev": false,
        "configPath": display(&config_path)?, "configParent": display(&config_parent)?,
        "overridePath": display(&patch_path)?, "overrideSha256": sha256(&patch_bytes),
        "frontendDistKind": variant, "classifyOnly": options.classify_only,
    });
    if variant != "Directory" {
        report["error"] = json!(
            "frontendDist must resolve to Directory; URL/Files/None cannot establish this embedding boundary"
        );
        return Ok(report);
    }
    if options.classify_only {
        report["verified"] = json!(true);
        return Ok(report);
    }
    if !matches!(config.app.security.pattern, PatternKind::Brownfield) {
        return Err("Only the reviewed Brownfield asset transform is supported".into());
    }
    let Some(FrontendDist::Directory(dist)) = &config.build.frontend_dist else {
        unreachable!()
    };
    let frontend = canonical(&config_parent.join(dist))?;
    if !frontend.is_dir() {
        return Err("frontendDist is not a directory".into());
    }
    let before = inventory(&frontend)?;
    if before.is_empty() || !before.contains_key("/index.html") {
        return Err("Frontend closure must be nonempty and contain /index.html".into());
    }
    let requested = options.out_dir.ok_or("Missing output directory")?;
    let parent = canonical(requested.parent().ok_or("Output has no parent")?)?;
    let out = parent.join(requested.file_name().ok_or("Output has no filename")?);
    if out.starts_with(&frontend) || frontend.starts_with(&out) || out.starts_with(&config_parent) {
        return Err("OUT_DIR must be separate from the input/configuration directories".into());
    }
    fs::create_dir(&out).map_err(|e| format!("OUT_DIR must be a new directory: {e}"))?;
    let out = canonical(&out)?;
    unsafe {
        env::set_var("OUT_DIR", &out);
    }
    let generated = tauri_codegen::context_codegen(tauri_codegen::ContextData {
        dev: false,
        config,
        config_parent,
        root: "::tauri".parse().map_err(|e| format!("{e}"))?,
        capabilities: None,
        assets: None,
        test: false,
    })
    .map_err(|e| e.to_string())?;
    let token_bytes = generated.to_string().into_bytes();
    let mut mapping = asset_map(syn::parse2::<Expr>(generated).map_err(|e| e.to_string())?)?;
    mapping.sort_by(|a, b| a.key.cmp(&b.key));
    if mapping.iter().map(|a| &a.key).collect::<Vec<_>>() != before.keys().collect::<Vec<_>>() {
        return Err("Generated asset key closure differs from all frontend files".into());
    }
    let cache_root = canonical(&out.join("tauri-codegen-assets"))?;
    let mut assets = Vec::new();
    let mut caches = BTreeMap::<String, Value>::new();
    for entry in mapping {
        let expected = &before[&entry.key];
        let input = canonical(&entry.input)?;
        let cache = canonical(&entry.cache)?;
        if input != expected.path || cache.parent() != Some(cache_root.as_path()) {
            return Err(format!(
                "Codegen path mapping escaped its input/cache boundary: {}",
                entry.key
            ));
        }
        let compressed = bytes(&cache)?;
        let mut transformed = Vec::new();
        brotli::Decompressor::new(Cursor::new(&compressed), 4096)
            .take(MAX_ASSET_BYTES + 1)
            .read_to_end(&mut transformed)
            .map_err(|e| format!("Brotli decode: {e}"))?;
        if transformed.len() as u64 > MAX_ASSET_BYTES {
            return Err("Oversized decompressed asset".into());
        }
        let transformed_blake3 = blake3(&transformed);
        let extension = input.extension().and_then(|e| e.to_str());
        let expected_name = extension.map_or_else(
            || transformed_blake3.clone(),
            |ext| format!("{transformed_blake3}.{ext}"),
        );
        if cache.file_name().and_then(|n| n.to_str()) != Some(expected_name.as_str()) {
            return Err(format!(
                "Codegen BLAKE3 cache filename mismatch: {}",
                entry.key
            ));
        }
        let transformed_sha256 = sha256(&transformed);
        if extension != Some("html")
            && (transformed.len() != expected.length || transformed_sha256 != expected.sha256)
        {
            return Err(format!("Unexpected non-HTML transformation: {}", entry.key));
        }
        let cache_path = display(&cache)?;
        let cache_record = json!({
            "cachePath": cache_path, "bytes": compressed.len(), "sha256": sha256(&compressed),
            "transformedBytes": transformed.len(), "transformedSha256": transformed_sha256,
            "transformedBlake3": transformed_blake3,
        });
        if let Some(previous) = caches.insert(cache_path.clone(), cache_record.clone()) {
            if previous != cache_record {
                return Err("Conflicting deduplicated cache records".into());
            }
        }
        assets.push(json!({
            "key": entry.key, "inputPath": display(&input)?, "cachePath": cache_path,
            "codegenInputPath": entry.input.to_str().ok_or("Non-Unicode codegen path")?,
            "codegenCachePath": entry.cache.to_str().ok_or("Non-Unicode codegen cache path")?,
            "inputBytes": expected.length, "inputSha256": expected.sha256,
            "transformedBytes": transformed.len(), "transformedSha256": transformed_sha256,
            "transformedBlake3": transformed_blake3,
            "compressedBytes": compressed.len(), "compressedSha256": sha256(&compressed),
        }));
    }
    let actual_cache = inventory(&cache_root)?
        .values()
        .map(|i| display(&i.path))
        .collect::<ProbeResult<BTreeSet<_>>>()?;
    if actual_cache != caches.keys().cloned().collect::<BTreeSet<_>>()
        || inventory(&frontend)? != before
    {
        return Err("Source/cache closure changed during code generation".into());
    }
    let tokens_path = out.join("context.tokens.rs");
    fs::write(&tokens_path, &token_bytes).map_err(|e| e.to_string())?;
    report["verified"] = json!(true);
    report["frontendRoot"] = json!(display(&frontend)?);
    report["outDir"] = json!(display(&out)?);
    report["compression"] = json!("brotli");
    report["assetCount"] = json!(assets.len());
    report["cacheCount"] = json!(caches.len());
    report["assets"] = json!(assets);
    report["cacheFiles"] = json!(caches.into_values().collect::<Vec<_>>());
    report["generatedTokens"] = json!({"path": display(&tokens_path)?, "bytes": token_bytes.len(), "sha256": sha256(&token_bytes)});
    Ok(report)
}

fn main() {
    let result = match run() {
        Ok(value) => value,
        Err(error) => {
            json!({"schemaVersion": 1, "kind": KIND, "verified": false, "nativeExecutableBound": false, "error": error})
        }
    };
    println!("{}", result);
    if result["verified"] != true {
        std::process::exit(1);
    }
}
