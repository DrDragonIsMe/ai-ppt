#!/bin/sh
set -e

SKILLS_DIR="$(cd "$(dirname "$0")" && pwd)/skills"
AGENTS_SKILLS_DIR="$HOME/.agents/skills"
KIMI_SKILLS_DIR="$HOME/.kimi-code/skills"

mkdir -p "$AGENTS_SKILLS_DIR" "$KIMI_SKILLS_DIR"

install_skill() {
  name="$1"
  src="$SKILLS_DIR/$name"
  dest="$AGENTS_SKILLS_DIR/$name"
  link="$KIMI_SKILLS_DIR/$name"

  if [ ! -d "$src" ]; then
    echo "Unknown skill: $name" >&2
    return 1
  fi

  if [ -e "$dest" ]; then
    echo "Updating $name in $dest"
    rm -rf "$dest"
  else
    echo "Installing $name to $dest"
  fi
  cp -R "$src" "$dest"

  if [ -e "$link" ] || [ -L "$link" ]; then
    rm -rf "$link"
  fi
  ln -s "../../.agents/skills/$name" "$link"
  echo "Linked $link -> ../../.agents/skills/$name"
}

if [ $# -eq 0 ]; then
  for src in "$SKILLS_DIR"/*; do
    name="$(basename "$src")"
    install_skill "$name"
  done
else
  for name in "$@"; do
    install_skill "$name"
  done
fi

echo "Done. Restart your CLI session if skills are not immediately available."
