#!/usr/bin/env python3
"""Preview or update existing per-user containers; organization-specific legacy migration stays private.

Run from a checkout with WORKPARTNER_ORG_DIR and the deployment environment set.
No changes occur without --apply. Images must already exist locally.
"""
import argparse
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys


def configuration():
    resolver = Path(os.environ.get('WORKPARTNER_ORG_RESOLVER', str(Path(__file__).resolve().parents[1] / 'gateway/organization/resolve.mjs')))
    return json.loads(subprocess.check_output(['node', str(resolver), 'json'], text=True))


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def main():
    organization = configuration()
    parser = argparse.ArgumentParser(description='Preview per-user image updates')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--only', default='')
    parser.add_argument('--image', default=organization['runtime']['nextImage'])
    args = parser.parse_args()
    runtime = organization['runtime']
    users = json.loads(Path(runtime['hostData'] or runtime['rolloutData'], 'users.json').read_text())
    only = set(filter(None, args.only.split(',')))
    if only - {user['slug'] for user in users}:
        parser.error('unknown user')
    targets = [user for user in users if user.get('backend') == 'aionui' and (not only or user['slug'] in only)]
    protected = set(runtime['protectedUsers'])
    if protected & {user['slug'] for user in targets}:
        parser.error('selection includes a protected user')
    # Preserve all existing mounts, environment and resource limits. Re-creation belongs to the gateway.
    command('docker', 'image', 'inspect', args.image)
    if args.image != runtime['nextImage']:
        parser.error('set NEXT_IMAGE on the gateway before rolling out that image')
    for user in targets:
        container = runtime['nextContainerPrefix'] + user['slug']
        print(('apply ' if args.apply else 'preview ') + container + ' -> ' + args.image)
        if args.apply:
            # The gateway waits for active conversations before replacing an outdated image.
            program = r'''
const fs=require('fs'),crypto=require('crypto'),org=require('/app/gateway/organization/resolve.mjs').resolveOrganization();
const [u,n]=process.argv.slice(1),key=fs.readFileSync(org.runtime.sessionKeyFile,'utf8').trim();
const data=Buffer.from(JSON.stringify({u,n,a:'',e:Math.floor(Date.now()/1000)+600})).toString('base64url');
const cookie='wp_sid='+data+'.'+crypto.createHmac('sha256',key).update(data).digest('base64url');
fetch(org.runtime.gatewayOrigin+'/',{headers:{cookie},redirect:'manual'}).then(r=>{
  if(r.status>=400)process.exitCode=1;else console.log('gateway accepted');
}).catch(()=>{process.exitCode=1});
'''
            print(command('docker', 'exec', runtime['gatewayContainer'], 'node', '-e', program, user['unionId'], user.get('name', '')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
