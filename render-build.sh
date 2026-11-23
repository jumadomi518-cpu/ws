
#!/usr/bin/env bash

set -e

echo "Installing system dependencies..."

apt-get update

apt-get install -y \
  libreoffice \
  mupdf-tools \
  poppler-utils

echo "Checking installations..."

which libreoffice
which mutool
which pdftoppm

echo "Installing Node dependencies..."

npm install

echo "Build completed successfully."

