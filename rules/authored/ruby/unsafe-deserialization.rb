class SessionsController < ApplicationController
  def restore
    # ruleid: radr.ruby.unsafe-deserialization
    state = Marshal.load(Base64.decode64(cookies[:state]))
    # ruleid: radr.ruby.unsafe-deserialization
    cfg = YAML.unsafe_load(request.body.read)
    # ok: radr.ruby.unsafe-deserialization
    data = JSON.parse(request.body.read)
    # ok: radr.ruby.unsafe-deserialization
    local = Marshal.load(File.binread("cache.bin"))
  end
end
