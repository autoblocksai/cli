#!/bin/bash

# Fixes the types field in package.json
modify_package_json() {
    local module_name=$1
    local types_dir=$2

    jq ".types = \"$types_dir\"" node_modules/${module_name}/package.json > node_modules/${module_name}/package.json.tmp
    mv node_modules/${module_name}/package.json.tmp node_modules/${module_name}/package.json
}

modify_package_json "ink" "build/"
modify_package_json "ink-link" "dist/"
modify_package_json "ink-spinner" "build/"
