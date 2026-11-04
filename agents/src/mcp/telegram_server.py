"""MCP server exposing Telegram-specific tools to Claude.

Runs as a stdio transport server. The ``send_image_to_user`` tool validates
file existence and extension, then returns a success string. Actual Telegram
delivery is handled by the bot's stream callback which intercepts the tool
call.
"""

from pathlib import Path

try:
    # mcp >= 2.0 renamed FastMCP to MCPServer. The surface used here -- the
    # constructor, the .tool() decorator and .run(transport=...) -- is identical
    # in both, so one guarded import is the whole compatibility story.
    from mcp.server.mcpserver import MCPServer as _Server
except ImportError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as _Server

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}

mcp = _Server("telegram")


@mcp.tool()
async def send_image_to_user(file_path: str, caption: str = "") -> str:
    """Send an image file to the Telegram user.

    Args:
        file_path: Absolute path to the image file.
        caption: Optional caption to display with the image.

    Returns:
        Confirmation string when the image is queued for delivery.
    """
    path = Path(file_path)

    if not path.is_absolute():
        return f"Error: path must be absolute, got '{file_path}'"

    if path.suffix.lower() not in IMAGE_EXTENSIONS:
        return (
            f"Error: unsupported image extension '{path.suffix}'. "
            f"Supported: {', '.join(sorted(IMAGE_EXTENSIONS))}"
        )

    if not path.is_file():
        return f"Error: file not found: {file_path}"

    return f"Image queued for delivery: {path.name}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
