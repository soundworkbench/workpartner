#!/bin/bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: distribute-image.sh IMAGE --node SSH_TARGET [--node SSH_TARGET...] --namespace NAME [options]
       distribute-image.sh --unpin IMAGE --node SSH_TARGET [--node SSH_TARGET...]

Options:
  --replace                 Allow replacing an existing tag with a different ID
  --configmap NAME          Image registry (default: workpartner-images)
  --kubeconfig FILE          Administrator kubeconfig (JSON)
  --data-dir PATH            Remote containerd filesystem (default: /var/lib/rancher/k3s/agent/containerd)
  --min-free-bytes BYTES     Required free space; default: twice image size plus 1 GiB

Requires local docker, ssh, kubectl and python3 (standard library). SSH targets
must permit noninteractive k3s ctr/crictl and df commands. Configure SSH options
in ssh_config. No image registry or remote Node/Python installation is needed.
Unpin only removes the pinned label; it does not delete images or registration.
The archive is saved once locally (TMPDIR needs room for the image). Expected CRI
IDs are config SHA256 digests read from Docker or OCI archives, not Docker inspect
IDs, which may identify a manifest/index. Archives with multiple distinct configs
are rejected; export a single-platform image for the target nodes.
USAGE
}
fail() { printf '%s\n' "$*" >&2; exit 1; }
image= namespace= configmap=workpartner-images kubeconfig= min_free=
data_dir=/var/lib/rancher/k3s/agent/containerd
replace=false unpin=false
nodes=()
while (( $# )); do
  case "$1" in
    --help) usage; exit 0 ;;
    --replace) replace=true; shift ;;
    --node|--namespace|--configmap|--kubeconfig|--data-dir|--min-free-bytes|--unpin)
      [[ $# -ge 2 && -n $2 ]] || fail "Missing value for $1"
      case "$1" in
        --node) nodes+=("$2") ;;
        --namespace) namespace=$2 ;;
        --configmap) configmap=$2 ;;
        --kubeconfig) kubeconfig=$2 ;;
        --data-dir) data_dir=$2 ;;
        --min-free-bytes) min_free=$2 ;;
        --unpin) [[ -z $image ]] || fail 'Specify only one image'; image=$2; unpin=true ;;
      esac
      shift 2 ;;
    -*) fail "Unknown argument: $1" ;;
    *) [[ -z $image ]] || fail 'Specify only one image'; image=$1; shift ;;
  esac
done
[[ -n $image && ${#nodes[@]} -gt 0 ]] || fail 'An image and at least one --node are required'
for target in "${nodes[@]}"; do
  [[ $target =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$ ]] || fail 'Invalid SSH target'
done
[[ $data_dir == /* && $data_dir != *$'\n'* ]] || fail '--data-dir must be an absolute path'
[[ -z $min_free || $min_free =~ ^[1-9][0-9]*$ ]] || fail '--min-free-bytes must be positive'
if ! $unpin; then
  [[ $namespace =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#namespace} -le 63 ]] || fail 'A valid --namespace is required'
  [[ $configmap =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ && ${#configmap} -le 253 ]] || fail 'Invalid ConfigMap name'
fi

# JSON and integer handling stay local. Never interpret remote output as shell.
json() {
  python3 -c '
import hashlib, json, re, sys, tarfile
mode, *args = sys.argv[1:]
def require(condition, message):
    if not condition:
        sys.exit(message)
def image_id(value):
    require(isinstance(value, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", value), "Invalid image ID")
    return value
def mapping(value):
    require(isinstance(value, dict), "Invalid image registration")
    return value
try:
    if mode == "reference":
        ref = args[0]
        require(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._/:@-]*", ref), "Invalid image reference")
        if "/" not in ref or not ("." in ref.split("/")[0] or ":" in ref.split("/")[0] or ref.split("/")[0] == "localhost"):
            ref = "docker.io/" + ref
        if ref.startswith("docker.io/") and ref.count("/") == 1:
            ref = "docker.io/library/" + ref.removeprefix("docker.io/")
        if ":" not in ref.rsplit("/", 1)[-1] and "@" not in ref:
            ref += ":latest"
        print(ref)
    elif mode == "source":
        info, = json.load(sys.stdin)
        size = info["Size"]
        require(isinstance(size, int) and size > 0, "Invalid image size")
        print(args[0] or size * 2 + 1024**3)
    elif mode == "archive":
        with tarfile.open(args[0], "r:*") as archive:
            def read_member(name):
                member = archive.getmember(name)
                require(member.isfile() and member.size <= 16 * 1024**2, "Invalid image metadata member")
                with archive.extractfile(member) as stream:
                    return stream.read()
            def digest(data):
                return "sha256:" + hashlib.sha256(data).hexdigest()
            def read_blob(descriptor):
                ident = image_id(descriptor["digest"])
                data = read_member("blobs/sha256/" + ident.split(":", 1)[1])
                require(digest(data) == ident, "Image archive digest mismatch")
                return data
            def configs(document, depth=0):
                require(depth < 8, "Image archive index nesting is too deep")
                if "manifests" in document:
                    return {ident for entry in document["manifests"]
                            for ident in configs(json.loads(read_blob(entry)), depth + 1)}
                config = document["config"]
                read_blob(config)
                return {image_id(config["digest"])}
            if "manifest.json" in archive.getnames():
                entries = json.loads(read_member("manifest.json"))
                ids = {digest(read_member(entry["Config"])) for entry in entries}
            else:
                ids = configs(json.loads(read_member("index.json")))
            require(len(ids) == 1, "Image archive must contain one config ID; export a single-platform image")
            print(next(iter(ids)))
    elif mode == "disk":
        lines = sys.stdin.read().strip().splitlines()
        require(len(lines) == 2, "Invalid df output")
        free = int(lines[1].split()[3]) * 1024
        require(free >= int(args[0]), "Insufficient node disk space")
    elif mode == "existing":
        images = json.load(sys.stdin)["images"]
        require(isinstance(images, list), "Invalid CRI image list")
        ids = {image_id(info["id"]) for info in images if any(ref in (info.get("repoTags") or []) + (info.get("repoDigests") or []) for ref in args)}
        require(len(ids) <= 1, "Ambiguous existing image")
        print(next(iter(ids), ""))
    elif mode == "inspect":
        print(image_id(json.load(sys.stdin)["status"]["id"]))
    elif mode == "kubeconfig":
        require(isinstance(json.load(open(args[0])), dict), "Kubeconfig must be JSON")
    elif mode == "registration":
        ref, ident, namespace, name = args
        raw = sys.stdin.read().strip()
        current = json.loads(raw) if raw else None
        if current is not None:
            version = current["metadata"]["resourceVersion"]
            require(isinstance(version, str) and version, "Missing ConfigMap resourceVersion")
            data = mapping(current.get("data", {}))
            images = mapping(json.loads(data.get("images.json", "{}")))
            for value in images.values():
                image_id(value)
            metadata = {"resourceVersion": version}
        else:
            images = {}
            metadata = {"name": name, "namespace": namespace}
        images[ref] = image_id(ident)
        result = {"metadata": metadata, "data": {"images.json": json.dumps(images)}}
        if current is None:
            result.update(apiVersion="v1", kind="ConfigMap")
        print(json.dumps(result))
except (ValueError, KeyError, TypeError, AttributeError, IndexError, OSError, tarfile.TarError):
    sys.exit("Invalid " + mode + " data")
' "$@"
}

# OpenSSH joins command arguments into a remote shell command. Quote every word.
remote() {
  local target=$1 word command=
  shift
  for word in "$@"; do
    command+="'${word//\'/\'\\\'\'}' "
  done
  ssh -o BatchMode=yes -- "$target" "$command"
}
reference=$(json reference "$image")
work_dir=
attempted_nodes=()
imported_nodes=()
cleanup() {
  local status=$?
  if (( status != 0 && ${#attempted_nodes[@]} > 0 )); then
    printf 'Distribution failed. Imported nodes: %s\n' "${imported_nodes[*]:-(none confirmed)}" >&2
    printf 'Changed or possibly partially changed nodes: %s\n' "${attempted_nodes[*]}" >&2
    printf 'Recovery: use --unpin IMAGE on these nodes to remove pins, or rerun distribution (with --replace if needed). Unpin does not restore old tags or remove imported content; re-distribute the previous image to roll back a replacement.\n' >&2
  fi
  if [[ -n $work_dir ]]; then rm -rf -- "$work_dir"; fi
  exit "$status"
}
trap cleanup EXIT
if $unpin; then
  for target in "${nodes[@]}"; do
    existing=$(remote "$target" k3s crictl images --output json | json existing "$reference" "$image")
    [[ -n $existing ]] || continue
    attempted_nodes+=("$target")
    remote "$target" k3s ctr -n k8s.io images label "$reference" 'io.cri-containerd.pinned='
  done
  exit 0
fi
kubectl_args=(--namespace "$namespace")
if [[ -n $kubeconfig ]]; then
  json kubeconfig "$kubeconfig"
  kubectl_args+=(--kubeconfig "$kubeconfig")
fi
required_free=$(docker image inspect "$image" | json source "$min_free")

# Check every target before changing the first one. Missing images are distinguished
# from failed CRI requests by listing images successfully, not by ignoring errors.
for target in "${nodes[@]}"; do
  remote "$target" df -Pk -- "$data_dir" | json disk "$required_free"
done
# Derive the config ID from exactly the bytes that will be imported everywhere.
work_dir=$(mktemp -d)
docker save "$image" >"$work_dir/image.tar"
expected_id=$(json archive "$work_dir/image.tar")
for target in "${nodes[@]}"; do
  existing=$(remote "$target" k3s crictl images --output json | json existing "$reference" "$image")
  if [[ -n $existing && $existing != "$expected_id" ]] && ! $replace; then
    fail "Existing tag has a different ID on $target; use --replace"
  fi
done
for target in "${nodes[@]}"; do
  printf 'Importing image on %s\n' "$target" >&2
  attempted_nodes+=("$target")
  remote "$target" k3s ctr -n k8s.io images import - <"$work_dir/image.tar"
  imported_nodes+=("$target")
  remote "$target" k3s ctr -n k8s.io images label "$reference" io.cri-containerd.pinned=pinned
  actual_id=$(remote "$target" k3s crictl inspecti "$reference" | json inspect)
  [[ $actual_id == "$expected_id" ]] || fail "Image ID mismatch on $target; registration unchanged"
done

# A resourceVersion precondition prevents overwriting concurrent registrations.
current=$(kubectl "${kubectl_args[@]}" get configmap "$configmap" --ignore-not-found -o json)
patch=$work_dir/registration.json
printf '%s' "$current" | json registration "$image" "$expected_id" "$namespace" "$configmap" >"$patch"
if [[ -n $current ]]; then
  kubectl "${kubectl_args[@]}" patch configmap "$configmap" --type merge --patch-file "$patch"
else
  kubectl "${kubectl_args[@]}" create -f "$patch"
fi
printf 'Registered %s as %s\n' "$image" "$expected_id"
