# Config overlay on top of the VoiceLink image. Ships this repo's customized
# registry.py and service_factory.py; installs no extra providers (Sarvam and
# every other provider we use are already in the base image).
FROM local/dograh-api:voicelink-v1

# The base image runs as `dograh`, but /app is root-owned.
USER root

COPY --chown=dograh:dograh registry.py        /app/api/services/configuration/registry.py
COPY --chown=dograh:dograh service_factory.py /app/api/services/pipecat/service_factory.py

# Restore the base image's runtime user.
USER dograh