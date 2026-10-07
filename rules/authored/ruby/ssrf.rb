class FetchController < ApplicationController
  def preview
    url = params[:url]
    # ruleid: radr.ruby.ssrf
    body = URI.open(url).read
    # ruleid: radr.ruby.ssrf
    res = Net::HTTP.get(URI(params[:target]))
    # ruleid: radr.ruby.ssrf
    HTTParty.get(url)
    # ok: radr.ruby.ssrf
    HTTParty.get("https://api.example.com/status")
  end
end
