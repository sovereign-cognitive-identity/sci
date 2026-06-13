#!/bin/bash
#
# benchmarks/run.sh
#
# SCI-273 benchmark runner: assemble corpus, compute metrics, generate results.
#
# Usage:
#   cd benchmarks && bash run.sh
#

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CORPUS_DIR="$SCRIPT_DIR/corpus"
RESULTS_FILE="$SCRIPT_DIR/RESULTS.md"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}SCI-273 Benchmark Runner${NC}"
echo "Repository: $REPO_ROOT"
echo "Corpus dir: $CORPUS_DIR"
echo ""

# Step 1: Build/ensure corpus
if [ ! -f "$CORPUS_DIR/corpus-index.jsonl" ]; then
    echo -e "${BLUE}Step 1: Building corpus index...${NC}"
    cd "$SCRIPT_DIR"
    python3 corpus-builder.py
    echo -e "${GREEN}✓ Corpus index created${NC}"
    echo ""
else
    echo -e "${BLUE}Step 1: Corpus index found (skipping build)${NC}"
    echo ""
fi

# Step 2: Build Rust benchmark harness
echo -e "${BLUE}Step 2: Building Rust benchmark harness...${NC}"
cd "$REPO_ROOT"

# Check if benchmarks crate exists
if [ ! -f "benchmarks/Cargo.toml" ]; then
    echo -e "${RED}✗ benchmarks/Cargo.toml not found${NC}"
    exit 1
fi

cargo build --manifest-path benchmarks/Cargo.toml --release 2>&1 | tail -3
HARNESS_BIN="$SCRIPT_DIR/target/release/bench-harness"

if [ ! -f "$HARNESS_BIN" ]; then
    echo -e "${RED}✗ Failed to build harness binary${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Harness built at $HARNESS_BIN${NC}"
echo ""

# Step 3+4: Compute real metrics and generate RESULTS.md (SCI-291/292)
echo -e "${BLUE}Step 3+4: Computing metrics + generating report...${NC}"
cd "$SCRIPT_DIR"
python3 eval.py
echo -e "${GREEN}✓ Results report written to $RESULTS_FILE${NC}"
echo ""


# Step 5: Summary
echo -e "${BLUE}Step 5: Summary${NC}"
echo ""
echo "Benchmark complete!"
echo ""
echo "Artifacts:"
echo "  - Corpus: $CORPUS_DIR/corpus-index.jsonl ($(grep -c . "$CORPUS_DIR/corpus-index.jsonl") docs)"
echo "  - Report: $RESULTS_FILE"
echo ""
echo "To include Presidio results, run:"
echo "  cd $SCRIPT_DIR/presidio && python3 runner.py --corpus ../corpus/corpus-index.jsonl"
echo ""
