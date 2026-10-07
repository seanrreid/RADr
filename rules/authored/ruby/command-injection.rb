class ToolsController < ApplicationController
  def ping
    host = params[:host]
    # ruleid: radr.ruby.command-injection
    system("ping -c 1 #{host}")
    # ruleid: radr.ruby.command-injection
    out = `nslookup #{params[:domain]}`
    # ruleid: radr.ruby.command-injection
    Open3.capture2("dig " + host)
    # ok: radr.ruby.command-injection
    system("ping", "-c", "1", host)
    # ok: radr.ruby.command-injection
    system("ping -c 1 #{Shellwords.escape(host)}")
  end
end
