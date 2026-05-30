import subprocess
import sys
import os

def run_agy(prompt, dangerously_skip_permissions=True, conversation_id=None, agy_path='agy'):
    """
    Runs a prompt using the Antigravity CLI (agy) and returns the output.
    """
    # Ensure ~/.local/bin is in the environment PATH
    env = os.environ.copy()
    home_bin = os.path.expanduser('~/.local/bin')
    env["PATH"] = f"{home_bin}:{env.get('PATH', '')}"

    cmd = [agy_path, "--print", prompt]
    if dangerously_skip_permissions:
        cmd.append("--dangerously-skip-permissions")
    if conversation_id:
        cmd.extend(["--conversation", conversation_id])

    try:
        result = subprocess.run(cmd, env=env, capture_output=True, text=True, check=True, stdin=subprocess.DEVNULL)
        return {
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
            "success": True,
            "code": result.returncode
        }
    except subprocess.CalledProcessError as e:
        return {
            "stdout": e.stdout.strip() if e.stdout else "",
            "stderr": e.stderr.strip() if e.stderr else str(e),
            "success": False,
            "code": e.returncode
        }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python python_wrapper.py \"your prompt here\"")
        sys.exit(1)
        
    prompt_text = sys.argv[1]
    print(f"Running agy with prompt: \"{prompt_text}\"...")
    res = run_agy(prompt_text)
    
    print("\n--- OUTPUT ---")
    print(res["stdout"] if res["stdout"] else "(No Output)")
    if res["stderr"]:
        print("\n--- ERROR/WARNINGS ---")
        print(res["stderr"])
    
    sys.exit(0 if res["success"] else 1)
