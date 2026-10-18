# Stand-in for the engine's main.py in test/align-helper.test.js: run as `sh -u fake-align-helper.sh`
# (the client spawns "<python> -u <server>"); hands over to the Node fake next to it.
exec "$FAKE_NODE" "$(dirname "$0")/fake-align-helper.js"
