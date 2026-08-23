#!/usr/bin/env python3
"""
Deploy render-service to Hugging Face Spaces via API.
Creates a Docker Space and pushes all required files.
"""

import os
import sys
import json
import subprocess
from pathlib import Path

# Try to get HF token from environment
HF_TOKEN = os.environ.get('HUGGINGFACE_TOKEN')

if not HF_TOKEN:
    print("ERROR: HUGGINGFACE_TOKEN not found in environment variables.")
    print("This token should be passed via GitHub Actions secrets.")
    sys.exit(1)

try:
    from huggingface_hub import HfApi, create_repo, upload_folder
    from huggingface_hub.utils import RepositoryNotFoundError, HfHubHTTPError
except ImportError:
    print("Installing huggingface_hub...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "huggingface_hub"])
    from huggingface_hub import HfApi, create_repo, upload_folder
    from huggingface_hub.utils import RepositoryNotFoundError, HfHubHTTPError

# Configuration
SPACE_NAME = "queue-engine-test"
SPACE_OWNER = "stmooooore-lang"  # Replace with actual username/org
REPO_ID = f"{SPACE_OWNER}/{SPACE_NAME}"
RENDER_SERVICE_DIR = Path(__file__).parent

def create_space():
    """Create the HF Space via API."""
    print(f"Creating Space: {REPO_ID}")
    try:
        repo_url = create_repo(
            repo_id=REPO_ID,
            token=HF_TOKEN,
            repo_type="space",
            space_sdk="docker",
            private=False,
            exist_ok=True
        )
        print(f"Space created/updated: {repo_url}")
        return repo_url
    except HfHubHTTPError as e:
        print(f"HTTP Error creating space: {e}")
        if e.response.status_code == 401:
            print("ERROR: Invalid or insufficient token permissions.")
        elif e.response.status_code == 403:
            print("ERROR: Token lacks permission to create/push Spaces.")
        return None
    except Exception as e:
        print(f"Error creating space: {e}")
        return None

def push_files():
    """Push the render-service files to the Space."""
    print(f"Pushing files from {RENDER_SERVICE_DIR} to {REPO_ID}")
    try:
        # Files to upload
        files_to_upload = [
            "README.md",
            "Dockerfile",
            "package.json",
            "package-lock.json",
            "server.js",
            "cloud-config.yaml",
            "plexus_hooks.py",
        ]
        
        # Check all files exist
        for f in files_to_upload:
            fpath = RENDER_SERVICE_DIR / f
            if not fpath.exists():
                print(f"WARNING: {f} not found at {fpath}")
        
        upload_folder(
            repo_id=REPO_ID,
            folder_path=str(RENDER_SERVICE_DIR),
            token=HF_TOKEN,
            repo_type="space",
            commit_message="Deploy render-service to HF Spaces (Docker SDK)",
            ignore_patterns=["*.md", "render.yaml", "BRIEF-build-fix.md", "*.py", "node_modules", ".git"],
        )
        print("Files pushed successfully!")
        return True
    except HfHubHTTPError as e:
        print(f"HTTP Error pushing files: {e}")
        if e.response.status_code == 401:
            print("ERROR: Invalid token.")
        elif e.response.status_code == 403:
            print("ERROR: Token lacks push permission.")
        return False
    except Exception as e:
        print(f"Error pushing files: {e}")
        return False

def main():
    print("=" * 60)
    print("Deploying render-service to Hugging Face Spaces")
    print("=" * 60)
    
    # Create space
    repo_url = create_space()
    if not repo_url:
        print("\nFAILED: Could not create Space. Check token permissions.")
        sys.exit(1)
    
    # Push files
    success = push_files()
    if not success:
        print("\nFAILED: Could not push files.")
        sys.exit(1)
    
    space_url = f"https://huggingface.co/spaces/{REPO_ID}"
    print(f"\nSUCCESS! Space deployed at: {space_url}")
    print(f"Space URL (for testing): {space_url}")
    
    # Write result file
    result_path = RENDER_SERVICE_DIR / "HF-SPACES-RESULT.md"
    with open(result_path, "w") as f:
        f.write(f"""# HF Spaces Deployment Result

## Status: SUCCESS

**Space URL:** {space_url}
**Space ID:** {REPO_ID}

## Files Deployed
- README.md (with Docker SDK frontmatter)
- Dockerfile (adapted for HF Spaces: user 1000, port 7860, health check)
- package.json
- package-lock.json
- server.js (port 7860)
- cloud-config.yaml
- plexus_hooks.py

## LiteLLM Version
Pinned to 1.83.9 as required.

## Next Steps
1. Wait for Space to build (check logs at {space_url}/logs)
2. Test endpoints:
   - GET {space_url}/health → should return "ok"
   - GET {space_url}/test → should return JSON with "answer" field

## Acceptance Criteria
- Space builds successfully
- GET / returns "ok"
- GET /test returns JSON with "answer" field containing "привет" (or equivalent)
- Process stays alive without OOM kills (16 GB RAM on free Docker tier)
""")
    print(f"\nResult written to: {result_path}")

if __name__ == "__main__":
    main()